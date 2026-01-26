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
  ManifestEnforcementPolicy,
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

export type BuildRunContextInput<RunOptions extends RunContextOptions, RunResult> =
  BuildRunContextBaseInput<RunOptions> & {
    legacy: LegacyExecutor<RunOptions, RunResult>;
  };


// =============================================================================
// HELPERS
// =============================================================================

function buildContainerResources(config: ProjectConfig["docker"]): RunContextResolved["docker"]["containerResources"] {
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

function resolveControlPlaneConfig(config: ProjectConfig): ControlPlaneRunConfig {
  const raw = (config.control_plane ?? {}) as Partial<ProjectConfig["control_plane"]>;
  const rawChecks = (raw.checks ?? {}) as Partial<ProjectConfig["control_plane"]["checks"]>;
  const rawSurfacePatterns =
    (raw.surface_patterns ?? {}) as ControlPlaneSurfacePatternsConfig;
  const rawSurfaceLocks =
    (raw.surface_locks ?? {}) as Partial<ProjectConfig["control_plane"]["surface_locks"]>;
  const fallbackResourceRaw = raw.fallback_resource ?? "repo-root";
  const fallbackResource = fallbackResourceRaw.trim().length > 0
    ? fallbackResourceRaw.trim()
    : "repo-root";

  return {
    enabled: raw.enabled === true,
    componentResourcePrefix: raw.component_resource_prefix ?? "component:",
    fallbackResource,
    resourcesMode: raw.resources_mode ?? "prefer-derived",
    scopeMode: raw.scope_mode ?? "enforce",
    lockMode: raw.lock_mode ?? "declared",
    checks: {
      mode: rawChecks.mode ?? "off",
      commandsByComponent: rawChecks.commands_by_component ?? {},
      maxComponentsForScoped: rawChecks.max_components_for_scoped ?? 3,
      fallbackCommand: rawChecks.fallback_command,
    },
    surfacePatterns: resolveSurfacePatterns(rawSurfacePatterns),
    surfaceLocksEnabled: rawSurfaceLocks.enabled ?? false,
  };
}

function resolveValidatorMode(cfg?: { enabled?: boolean; mode?: ValidatorMode }): ValidatorMode {
  if (!cfg) return "off";
  if (cfg.enabled === false) return "off";
  return cfg.mode ?? "warn";
}

function resolveValidatorContext<TConfig extends { enabled?: boolean; mode?: ValidatorMode } | undefined>(
  config: TConfig,
): RunValidatorConfig<TConfig> {
  const mode = resolveValidatorMode(config);
  return {
    config,
    mode,
    enabled: mode !== "off",
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

  const isResume = input.options.resume ?? false;
  let runId = input.options.runId;
  if (isResume && !runId) {
    runId = await ports.stateRepository.findLatestRunId(input.projectName);
    if (!runId) {
      throw new Error(`No runs found to resume for project ${input.projectName}.`);
    }
  }
  if (!isResume) {
    runId = runId ?? defaultRunId();
  }

  const reuseCompleted = input.options.reuseCompleted ?? !isResume;
  const importRunId = input.options.importRun;
  const maxParallel = input.options.maxParallel ?? input.config.max_parallel;
  const cleanupConfig = input.config.cleanup ?? { workspaces: "never", containers: "never" };
  const cleanupWorkspacesOnSuccess = cleanupConfig.workspaces === "on_success";
  const cleanupContainersOnSuccess =
    input.options.cleanupOnSuccess ?? (cleanupConfig.containers === "on_success");
  const useDocker = input.options.useDocker ?? true;
  const stopContainersOnExit = input.options.stopContainersOnExit ?? false;
  const crashAfterContainerStart =
    process.env.MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START === "1";

  const tasksRootAbs = path.join(repoPath, input.config.tasks_dir);
  const tasksDirPosix = input.config.tasks_dir.split(path.sep).join(path.posix.sep);
  const workerImage = input.config.docker.image;
  const containerResources = buildContainerResources(input.config.docker);
  const containerSecurityPayload = buildContainerSecurityPayload(input.config.docker);
  const networkMode = input.config.docker.network_mode;
  const containerUser = input.config.docker.user;
  const controlPlaneConfig = resolveControlPlaneConfig(input.config);
  const manifestPolicy: ManifestEnforcementPolicy =
    input.config.manifest_enforcement ?? "warn";
  const costPer1kTokens = DEFAULT_COST_PER_1K_TOKENS;
  const mockLlmMode = isMockLlmEnabled() || input.config.worker.model === "mock";

  const resolved: RunContextResolved = {
    run: {
      runId,
      isResume,
      reuseCompleted,
      importRunId,
      maxParallel,
    },
    cleanup: {
      workspacesOnSuccess: cleanupWorkspacesOnSuccess,
      containersOnSuccess: cleanupContainersOnSuccess,
    },
    paths: {
      repoPath,
      tasksRootAbs,
      tasksDirPosix,
      myceliumHome: paths.myceliumHome,
    },
    docker: {
      useDocker,
      stopContainersOnExit,
      workerImage,
      containerResources,
      containerSecurityPayload,
      networkMode,
      containerUser,
    },
    controlPlane: {
      config: controlPlaneConfig,
    },
    policy: {
      manifestPolicy,
      costPer1kTokens,
      mockLlmMode,
    },
    flags: {
      crashAfterContainerStart,
    },
    validators: {
      test: resolveValidatorContext(input.config.test_validator),
      style: resolveValidatorContext(input.config.style_validator),
      architecture: resolveValidatorContext(input.config.architecture_validator),
      doctor: resolveValidatorContext(input.config.doctor_validator),
      doctorCanary: input.config.doctor_canary,
    },
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
