/**
 * RunContext builder for executor runs.
 * Purpose: resolve run-scoped config and derived values in one place.
 * Assumptions: config/options are already validated by the caller.
 * Usage: const ctx = await buildRunContext({ projectName, config, options, legacy }).
 */

import path from "node:path";

import { resolveSurfacePatterns } from "../../control-plane/policy/surface-detect.js";
import { DEFAULT_COST_PER_1K_TOKENS } from "../../core/budgets.js";
import type {
  ControlPlaneSurfacePatternsConfig,
  ProjectConfig,
  ValidatorMode,
} from "../../core/config.js";
import type { JsonObject } from "../../core/logger.js";
import type { PathsContext } from "../../core/paths.js";
import { createPathsContext, getDefaultPathsContext } from "../../core/paths.js";
import { defaultRunId } from "../../core/utils.js";
import { DEFAULT_CPU_PERIOD } from "../../docker/docker.js";
import { isMockLlmEnabled } from "../../llm/mock.js";

import type { OrchestratorPorts } from "./ports.js";
import {
  createDefaultPorts,
  type ControlPlaneRunConfig,
  type LegacyExecutor,
  type RunContext,
  type RunContextBase,
  type RunContextOptions,
  type RunContextResolved,
  type RunValidatorConfig,
} from "./run-context.js";

// =============================================================================
// TYPES
// =============================================================================

export type BuildRunContextBaseInput<RunOptions extends RunContextOptions> = {
  projectName: string;
  config: ProjectConfig;
  options: RunOptions;
  ports?: Partial<OrchestratorPorts>;
  paths?: PathsContext;
};

export type BuildRunContextInput<
  RunOptions extends RunContextOptions,
  RunResult,
> = BuildRunContextBaseInput<RunOptions> & {
  legacy: LegacyExecutor<RunOptions, RunResult>;
};

// =============================================================================
// HELPERS
// =============================================================================

function buildContainerResources(
  config: ProjectConfig["docker"],
): RunContextResolved["docker"]["containerResources"] {
  const memoryBytes =
    config.memory_mb !== undefined ? Math.trunc(config.memory_mb * 1024 * 1024) : undefined;
  const cpuQuota = config.cpu_quota;
  const pidsLimit = config.pids_limit;

  if (memoryBytes === undefined && cpuQuota === undefined && pidsLimit === undefined) {
    return undefined;
  }

  const limits: RunContextResolved["docker"]["containerResources"] = {};
  if (memoryBytes !== undefined) {
    limits.memoryBytes = memoryBytes;
  }
  if (cpuQuota !== undefined) {
    limits.cpuQuota = cpuQuota;
    limits.cpuPeriod = DEFAULT_CPU_PERIOD;
  }
  if (pidsLimit !== undefined) {
    limits.pidsLimit = pidsLimit;
  }

  return limits;
}

function buildContainerSecurityPayload(config: ProjectConfig["docker"]): JsonObject {
  const payload: JsonObject = {
    user: config.user,
    network_mode: config.network_mode,
  };

  if (config.memory_mb !== undefined) {
    payload.memory_mb = config.memory_mb;
  }
  if (config.cpu_quota !== undefined) {
    payload.cpu_quota = config.cpu_quota;
    payload.cpu_period = DEFAULT_CPU_PERIOD;
  }
  if (config.pids_limit !== undefined) {
    payload.pids_limit = config.pids_limit;
  }

  return payload;
}

function resolveControlPlaneFallbackResource(
  raw: Partial<ProjectConfig["control_plane"]>,
): string {
  const fallbackResourceRaw = raw.fallback_resource ?? "repo-root";
  const trimmed = fallbackResourceRaw.trim();
  return trimmed.length > 0 ? trimmed : "repo-root";
}

function resolveControlPlaneLockMode(
  raw: Partial<ProjectConfig["control_plane"]>,
): ControlPlaneRunConfig["lockMode"] {
  if (raw.lock_mode) {
    return raw.lock_mode;
  }
  return raw.enabled === true ? "derived" : "declared";
}

function resolveControlPlaneChecks(
  rawChecks: Partial<ProjectConfig["control_plane"]["checks"]>,
): ControlPlaneRunConfig["checks"] {
  return {
    mode: rawChecks.mode ?? "off",
    commandsByComponent: rawChecks.commands_by_component ?? {},
    maxComponentsForScoped: rawChecks.max_components_for_scoped ?? 3,
    fallbackCommand: rawChecks.fallback_command,
  };
}

function resolveControlPlaneConfig(config: ProjectConfig): ControlPlaneRunConfig {
  const raw = (config.control_plane ?? {}) as Partial<ProjectConfig["control_plane"]>;
  const rawChecks = (raw.checks ?? {}) as Partial<ProjectConfig["control_plane"]["checks"]>;
  const rawSurfacePatterns = (raw.surface_patterns ?? {}) as ControlPlaneSurfacePatternsConfig;
  const rawSurfaceLocks = (raw.surface_locks ?? {}) as Partial<
    ProjectConfig["control_plane"]["surface_locks"]
  >;

  return {
    enabled: raw.enabled === true,
    componentResourcePrefix: raw.component_resource_prefix ?? "component:",
    fallbackResource: resolveControlPlaneFallbackResource(raw),
    resourcesMode: raw.resources_mode ?? "prefer-derived",
    scopeMode: raw.scope_mode ?? "enforce",
    lockMode: resolveControlPlaneLockMode(raw),
    checks: resolveControlPlaneChecks(rawChecks),
    surfacePatterns: resolveSurfacePatterns(rawSurfacePatterns),
    surfaceLocksEnabled: rawSurfaceLocks.enabled ?? false,
  };
}

function resolveValidatorMode(cfg?: { enabled?: boolean; mode?: ValidatorMode }): ValidatorMode {
  if (!cfg) return "off";
  if (cfg.enabled === false) return "off";
  return cfg.mode ?? "warn";
}

function resolveValidatorContext<
  TConfig extends { enabled?: boolean; mode?: ValidatorMode } | undefined,
>(config: TConfig): RunValidatorConfig<TConfig> {
  const mode = resolveValidatorMode(config);
  return {
    config,
    mode,
    enabled: mode !== "off",
  };
}

async function resolveRunSettings<RunOptions extends RunContextOptions>(
  input: BuildRunContextBaseInput<RunOptions>,
  ports: OrchestratorPorts,
): Promise<RunContextResolved["run"]> {
  const isResume = input.options.resume ?? false;
  let runId = input.options.runId;

  if (isResume && !runId) {
    const latestRunId = await ports.stateRepository.findLatestRunId(input.projectName);
    runId = latestRunId ?? undefined;
  }
  if (isResume && !runId) {
    throw new Error(`No runs found to resume for project ${input.projectName}.`);
  }
  if (!isResume) {
    runId = runId ?? defaultRunId();
  }
  if (!runId) {
    throw new Error("Run id could not be resolved.");
  }

  return {
    runId,
    isResume,
    reuseCompleted: input.options.reuseCompleted ?? !isResume,
    importRunId: input.options.importRun,
    maxParallel: input.options.maxParallel ?? input.config.max_parallel,
  };
}

function resolveCleanupSettings<RunOptions extends RunContextOptions>(
  config: ProjectConfig,
  options: RunOptions,
): RunContextResolved["cleanup"] {
  const cleanupConfig = config.cleanup ?? { workspaces: "never", containers: "never" };

  return {
    workspacesOnSuccess: cleanupConfig.workspaces === "on_success",
    containersOnSuccess: options.cleanupOnSuccess ?? cleanupConfig.containers === "on_success",
  };
}

function resolvePathsConfig(
  repoPath: string,
  tasksDir: string,
  paths: PathsContext,
): RunContextResolved["paths"] {
  return {
    repoPath,
    tasksRootAbs: path.join(repoPath, tasksDir),
    tasksDirPosix: tasksDir.split(path.sep).join(path.posix.sep),
    myceliumHome: paths.myceliumHome,
  };
}

function resolveDockerSettings<RunOptions extends RunContextOptions>(
  config: ProjectConfig,
  options: RunOptions,
): RunContextResolved["docker"] {
  return {
    useDocker: options.useDocker ?? true,
    stopContainersOnExit: options.stopContainersOnExit ?? false,
    workerImage: config.docker.image,
    containerResources: buildContainerResources(config.docker),
    containerSecurityPayload: buildContainerSecurityPayload(config.docker),
    networkMode: config.docker.network_mode,
    containerUser: config.docker.user,
  };
}

function resolvePolicySettings(config: ProjectConfig): RunContextResolved["policy"] {
  return {
    manifestPolicy: config.manifest_enforcement ?? "warn",
    costPer1kTokens: DEFAULT_COST_PER_1K_TOKENS,
    mockLlmMode: isMockLlmEnabled() || config.worker.model === "mock",
  };
}

function resolveRunFlags<RunOptions extends RunContextOptions>(
  options: RunOptions,
): RunContextResolved["flags"] {
  return {
    crashAfterContainerStart: options.crashAfterContainerStart ?? false,
  };
}

function resolveValidatorSettings(config: ProjectConfig): RunContextResolved["validators"] {
  return {
    test: resolveValidatorContext(config.test_validator),
    style: resolveValidatorContext(config.style_validator),
    architecture: resolveValidatorContext(config.architecture_validator),
    doctor: resolveValidatorContext(config.doctor_validator),
    doctorCanary: config.doctor_canary,
  };
}

// =============================================================================
// PUBLIC API
// =============================================================================

export async function buildRunContextBase<RunOptions extends RunContextOptions>(
  input: BuildRunContextBaseInput<RunOptions>,
): Promise<RunContextBase<RunOptions>> {
  const repoPath = input.config.repo_path;
  const paths = input.paths ?? getDefaultPathsContext() ?? createPathsContext({ repoPath });

  const ports: OrchestratorPorts = {
    ...createDefaultPorts(input.config, paths),
    ...input.ports,
  };

  const run = await resolveRunSettings(input, ports);
  const cleanup = resolveCleanupSettings(input.config, input.options);
  const pathsConfig = resolvePathsConfig(repoPath, input.config.tasks_dir, paths);
  const docker = resolveDockerSettings(input.config, input.options);
  const controlPlaneConfig = resolveControlPlaneConfig(input.config);
  const policy = resolvePolicySettings(input.config);
  const flags = resolveRunFlags(input.options);
  const validators = resolveValidatorSettings(input.config);

  const resolved: RunContextResolved = {
    run,
    cleanup,
    paths: pathsConfig,
    docker,
    controlPlane: {
      config: controlPlaneConfig,
    },
    policy,
    flags,
    validators,
  };

  return {
    projectName: input.projectName,
    config: input.config,
    options: input.options,
    ports,
    resolved,
  };
}

export async function buildRunContext<RunOptions extends RunContextOptions, RunResult>(
  input: BuildRunContextInput<RunOptions, RunResult>,
): Promise<RunContext<RunOptions, RunResult>> {
  const base = await buildRunContextBase(input);

  return {
    ...base,
    legacy: input.legacy,
  };
}
