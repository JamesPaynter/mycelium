import path from "node:path";

import { execa, execaCommand } from "execa";
import fse from "fs-extra";

import {
  dockerClient,
  createContainer,
  startContainer,
  waitContainer,
  removeContainer,
  imageExists,
  findContainerByName,
  DEFAULT_CPU_PERIOD,
} from "../docker/docker.js";
import { buildWorkerImage } from "../docker/image.js";
import { streamContainerLogs, type LogStreamHandle } from "../docker/streams.js";
import { ensureCleanWorkingTree, checkout, resolveRunBaseSha } from "../git/git.js";
import { mergeTaskBranches } from "../git/merge.js";
import { buildTaskBranchName } from "../git/branches.js";
import { listChangedFiles } from "../git/changes.js";
import { ensureCodexAuthForHome } from "./codexAuth.js";
import { resolveCodexReasoningEffort } from "./codex-reasoning.js";

import type {
  ControlPlaneChecksMode,
  ControlPlaneLockMode,
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
  ControlPlaneSurfacePatternsConfig,
  DoctorValidatorConfig,
  ManifestEnforcementPolicy,
  ProjectConfig,
  ResourceConfig,
  ValidatorMode,
} from "./config.js";
import {
  DEFAULT_COST_PER_1K_TOKENS,
  detectBudgetBreaches,
  parseTaskTokenUsage,
  recomputeRunUsage,
  type TaskUsageUpdate,
} from "./budgets.js";
import {
  JsonlLogger,
  logJsonLineOrRaw,
  logOrchestratorEvent,
  logRunResume,
  logTaskReset,
  type JsonObject,
} from "./logger.js";
import { loadTaskSpecs } from "./task-loader.js";
import { normalizeLocks, type TaskSpec } from "./task-manifest.js";
import {
  orchestratorHome,
  orchestratorLogPath,
  taskEventsLogPath,
  taskComplianceReportPath,
  taskBlastReportPath,
  taskChecksetReportPath,
  taskLockDerivationReportPath,
  taskPolicyReportPath,
  taskLogsDir,
  taskWorkspaceDir,
  workerCodexHomeDir,
  validatorsLogsDir,
  validatorLogPath,
  validatorReportPath,
  runLogsDir,
  runSummaryReportPath,
} from "./paths.js";
import { buildGreedyBatch, topologicalReady, type BatchPlan, type LockResolver } from "./scheduler.js";
import { StateStore, findLatestRunId } from "./state-store.js";
import {
  completeBatch,
  createRunState,
  markTaskNeedsHumanReview,
  markTaskComplete,
  markTaskFailed,
  markTaskRescopeRequired,
  resetTaskToPending,
  startBatch,
  type CheckpointCommit,
  type ControlPlaneSnapshot,
  type RunState,
  type ValidatorResult,
  type ValidatorStatus,
} from "./state.js";
import { ensureDir, defaultRunId, isoNow, readJsonFile, writeJsonFile } from "./utils.js";
import { prepareTaskWorkspace } from "./workspaces.js";
import {
  runDoctorValidator,
  type DoctorValidationReport,
  type DoctorCanaryResult,
  type DoctorValidatorTrigger,
} from "../validators/doctor-validator.js";
import { runTestValidator, type TestValidationReport } from "../validators/test-validator.js";
import { runWorker } from "../../worker/loop.js";
import type { WorkerLogger, WorkerLogEventInput } from "../../worker/logging.js";
import { loadWorkerState, type WorkerCheckpoint } from "../../worker/state.js";
import {
  runManifestCompliance,
  type ManifestComplianceResult,
  type ResourceOwnershipResolver,
} from "./manifest-compliance.js";
import { computeRescopeFromCompliance } from "./manifest-rescope.js";
import { isMockLlmEnabled } from "../llm/mock.js";
import { buildControlPlaneModel } from "../control-plane/model/build.js";
import { ControlPlaneStore } from "../control-plane/storage.js";
import type { ControlPlaneModel } from "../control-plane/model/schema.js";
import {
  createComponentOwnerResolver,
  createComponentOwnershipResolver,
  deriveComponentResources,
} from "../control-plane/integration/resources.js";
import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../control-plane/integration/derived-scope.js";
import {
  buildBlastRadiusReport,
  type ControlPlaneBlastRadiusReport,
} from "../control-plane/integration/blast-radius.js";
import { resolveSurfacePatterns } from "../control-plane/policy/surface-detect.js";
import type { PolicyDecision, SurfacePatternSet } from "../control-plane/policy/types.js";
import { type ChecksetDecision } from "../control-plane/policy/checkset.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
} from "../control-plane/policy/eval.js";

const LABEL_PREFIX = "mycelium";

function containerLabel(
  labels: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!labels) return undefined;
  return labels[`${LABEL_PREFIX}.${key}`];
}

function buildContainerLabels(values: {
  projectName: string;
  runId: string;
  taskId: string;
  branchName: string;
  workspace: string;
}): Record<string, string> {
  return {
    [`${LABEL_PREFIX}.project`]: values.projectName,
    [`${LABEL_PREFIX}.run_id`]: values.runId,
    [`${LABEL_PREFIX}.task_id`]: values.taskId,
    [`${LABEL_PREFIX}.branch`]: values.branchName,
    [`${LABEL_PREFIX}.workspace_path`]: values.workspace,
  };
}

export type RunOptions = {
  runId?: string;
  resume?: boolean;
  tasks?: string[]; // limit to IDs
  maxParallel?: number;
  dryRun?: boolean;
  buildImage?: boolean;
  cleanupOnSuccess?: boolean;
  useDocker?: boolean;
  stopSignal?: AbortSignal;
  stopContainersOnExit?: boolean;
};

export type BatchPlanEntry = {
  batchId: number;
  taskIds: string[];
  locks: BatchPlan["locks"];
};

export type RunResult = {
  runId: string;
  state: RunState;
  plan: BatchPlanEntry[];
  stopped?: RunStopInfo;
};

type RunStopInfo = {
  reason: "signal";
  signal?: string;
  containers: "left_running" | "stopped";
  stopContainersRequested: boolean;
  stoppedContainers?: number;
  stopErrors?: number;
};

type StopRequest = { kind: "signal"; signal?: string };
type StopController = { readonly reason: StopRequest | null; cleanup: () => void };

type TaskSuccessResult = {
  success: true;
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
};

type TaskFailureResult = {
  success: false;
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
  errorMessage?: string;
  resetToPending?: boolean;
};

type TaskRunResult = TaskSuccessResult | TaskFailureResult;

type ValidatorRunSummary = {
  status: ValidatorStatus;
  summary: string | null;
  reportPath: string | null;
  trigger?: string;
};

type ContainerResourceLimits = {
  memoryBytes?: number;
  cpuQuota?: number;
  cpuPeriod?: number;
  pidsLimit?: number;
};

function buildContainerResources(config: ProjectConfig["docker"]): ContainerResourceLimits | undefined {
  const memoryBytes =
    config.memory_mb !== undefined ? Math.trunc(config.memory_mb * 1024 * 1024) : undefined;
  const cpuQuota = config.cpu_quota;
  const pidsLimit = config.pids_limit;

  if (memoryBytes === undefined && cpuQuota === undefined && pidsLimit === undefined) {
    return undefined;
  }

  const limits: ContainerResourceLimits = {};
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

type ControlPlaneChecksRunConfig = {
  mode: ControlPlaneChecksMode;
  commandsByComponent: Record<string, string>;
  maxComponentsForScoped: number;
  fallbackCommand?: string;
};

type ControlPlaneRunConfig = {
  enabled: boolean;
  componentResourcePrefix: string;
  fallbackResource: string;
  resourcesMode: ControlPlaneResourcesMode;
  scopeMode: ControlPlaneScopeMode;
  lockMode: ControlPlaneLockMode;
  checks: ControlPlaneChecksRunConfig;
  surfacePatterns: SurfacePatternSet;
  surfaceLocksEnabled: boolean;
};

function resolveControlPlaneConfig(config: ProjectConfig): ControlPlaneRunConfig {
  const raw = (config.control_plane ?? {}) as Partial<ProjectConfig["control_plane"]>;
  const rawChecks = (raw.checks ?? {}) as Partial<ProjectConfig["control_plane"]["checks"]>;
  const rawSurfacePatterns =
    (raw.surface_patterns ?? {}) as ControlPlaneSurfacePatternsConfig;
  const rawSurfaceLocks =
    (raw.surface_locks ?? {}) as Partial<ProjectConfig["control_plane"]["surface_locks"]>;
  return {
    enabled: raw.enabled === true,
    componentResourcePrefix: raw.component_resource_prefix ?? "component:",
    fallbackResource: raw.fallback_resource ?? "repo-root",
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

function resolveEffectiveLockMode(config: ControlPlaneRunConfig): ControlPlaneLockMode {
  return config.enabled ? config.lockMode : "declared";
}

function resolveScopeComplianceMode(config: ControlPlaneRunConfig): ControlPlaneScopeMode {
  return config.enabled ? config.scopeMode : "enforce";
}

async function buildControlPlaneSnapshot(input: {
  repoPath: string;
  baseSha: string;
  enabled: boolean;
}): Promise<ControlPlaneSnapshot> {
  if (!input.enabled) {
    return {
      enabled: false,
      base_sha: input.baseSha,
    };
  }

  const buildResult = await buildControlPlaneModel({
    repoRoot: input.repoPath,
    baseSha: input.baseSha,
  });
  const metadata = buildResult.metadata;
  const store = new ControlPlaneStore(input.repoPath);

  return {
    enabled: true,
    base_sha: buildResult.base_sha,
    model_hash: metadata.model_hash,
    model_path: store.getModelPath(buildResult.base_sha),
    built_at: metadata.built_at,
    schema_version: metadata.schema_version,
    extractor_versions: metadata.extractor_versions,
  };
}

function shouldBuildControlPlaneSnapshot(
  snapshot: ControlPlaneSnapshot | undefined,
): snapshot is ControlPlaneSnapshot & { base_sha: string } {
  if (!snapshot?.enabled || !snapshot.base_sha) {
    return false;
  }

  return (
    !snapshot.model_hash ||
    !snapshot.model_path ||
    !snapshot.schema_version ||
    !snapshot.extractor_versions
  );
}

type ResourceResolutionContext = {
  staticResources: ResourceConfig[];
  effectiveResources: ResourceConfig[];
  knownResources: string[];
  ownerResolver?: (filePath: string) => string | null;
  ownershipResolver?: ResourceOwnershipResolver;
  fallbackResource: string;
  resourcesMode: ControlPlaneResourcesMode;
};

type LoadedControlPlaneModel = {
  baseSha: string;
  model: ControlPlaneModel;
};

async function loadControlPlaneModel(input: {
  enabled: boolean;
  snapshot: ControlPlaneSnapshot | undefined;
}): Promise<LoadedControlPlaneModel | null> {
  if (!input.enabled || !input.snapshot?.enabled) {
    return null;
  }

  if (!input.snapshot.base_sha || !input.snapshot.model_path) {
    throw new Error("Control plane snapshot missing model metadata.");
  }

  const model = await readJsonFile<ControlPlaneModel>(input.snapshot.model_path);
  return { baseSha: input.snapshot.base_sha, model };
}

async function buildResourceResolutionContext(input: {
  repoPath: string;
  controlPlaneConfig: ControlPlaneRunConfig;
  controlPlaneSnapshot: ControlPlaneSnapshot | undefined;
  staticResources: ResourceConfig[];
}): Promise<ResourceResolutionContext> {
  const fallbackResource = input.controlPlaneConfig.enabled
    ? input.controlPlaneConfig.fallbackResource
    : "";
  const resourcesMode = input.controlPlaneConfig.resourcesMode;
  const derivedResources: ResourceConfig[] = [];
  let ownerResolver: ((filePath: string) => string | null) | undefined;
  let ownershipResolver: ResourceOwnershipResolver | undefined;

  const loadedModel = await loadControlPlaneModel({
    enabled: input.controlPlaneConfig.enabled,
    snapshot: input.controlPlaneSnapshot,
  });

  if (loadedModel) {
    const componentResources = deriveComponentResources({
      repoPath: input.repoPath,
      baseSha: loadedModel.baseSha,
      model: loadedModel.model,
      componentResourcePrefix: input.controlPlaneConfig.componentResourcePrefix,
    });
    derivedResources.push(...componentResources);
    ownerResolver = createComponentOwnerResolver({
      model: loadedModel.model,
      componentResourcePrefix: input.controlPlaneConfig.componentResourcePrefix,
    });
    ownershipResolver = createComponentOwnershipResolver({
      model: loadedModel.model,
      componentResourcePrefix: input.controlPlaneConfig.componentResourcePrefix,
    });
  }

  const effectiveResources = mergeResources({
    staticResources: input.staticResources,
    derivedResources,
  });
  const knownResources = mergeResourceNames({
    resources: effectiveResources,
    fallbackResource,
  });

  return {
    staticResources: input.staticResources,
    effectiveResources,
    knownResources,
    ownerResolver,
    ownershipResolver,
    fallbackResource,
    resourcesMode,
  };
}

function mergeResources(input: {
  staticResources: ResourceConfig[];
  derivedResources: ResourceConfig[];
}): ResourceConfig[] {
  const merged = new Map<string, ResourceConfig>();

  for (const resource of input.staticResources) {
    merged.set(resource.name, resource);
  }
  for (const resource of input.derivedResources) {
    if (!merged.has(resource.name)) {
      merged.set(resource.name, resource);
    }
  }

  return Array.from(merged.values()).sort(compareResourceByName);
}

function mergeResourceNames(input: {
  resources: ResourceConfig[];
  fallbackResource: string;
}): string[] {
  const names = new Set<string>();
  for (const resource of input.resources) {
    names.add(resource.name);
  }
  if (input.fallbackResource) {
    names.add(input.fallbackResource);
  }

  return Array.from(names).sort();
}

function compareResourceByName(a: ResourceConfig, b: ResourceConfig): number {
  return a.name.localeCompare(b.name);
}

async function emitDerivedScopeReports(input: {
  repoPath: string;
  runId: string;
  tasks: TaskSpec[];
  controlPlaneConfig: ControlPlaneRunConfig;
  controlPlaneSnapshot: ControlPlaneSnapshot | undefined;
  orchestratorLog: JsonlLogger;
}): Promise<Map<string, DerivedScopeReport>> {
  const reports = new Map<string, DerivedScopeReport>();
  const shouldCompute =
    input.controlPlaneConfig.enabled && input.controlPlaneConfig.lockMode !== "declared";
  if (!shouldCompute) {
    return reports;
  }

  const loadedModel = await loadControlPlaneModel({
    enabled: input.controlPlaneConfig.enabled,
    snapshot: input.controlPlaneSnapshot,
  });
  if (!loadedModel) {
    return reports;
  }

  let snapshot: Awaited<ReturnType<typeof createDerivedScopeSnapshot>> | null = null;
  try {
    snapshot = await createDerivedScopeSnapshot({
      repoPath: input.repoPath,
      baseSha: loadedModel.baseSha,
    });
  } catch (error) {
    logOrchestratorEvent(input.orchestratorLog, "control_plane.lock_derivation.error", {
      message: formatErrorMessage(error),
      base_sha: loadedModel.baseSha,
    });
    return reports;
  }

  try {
    for (const task of input.tasks) {
      try {
        const report = await deriveTaskWriteScopeReport({
          manifest: task.manifest,
          model: loadedModel.model,
          snapshotPath: snapshot.snapshotPath,
          componentResourcePrefix: input.controlPlaneConfig.componentResourcePrefix,
          fallbackResource: input.controlPlaneConfig.fallbackResource,
          surfaceLocksEnabled: input.controlPlaneConfig.surfaceLocksEnabled,
          surfacePatterns: input.controlPlaneConfig.surfacePatterns,
        });
        const reportPath = taskLockDerivationReportPath(
          input.repoPath,
          input.runId,
          task.manifest.id,
        );
        await writeJsonFile(reportPath, report);
        reports.set(task.manifest.id, report);

        logOrchestratorEvent(input.orchestratorLog, "task.lock_derivation", {
          taskId: task.manifest.id,
          task_slug: task.slug,
          report_path: reportPath,
          confidence: report.confidence,
          resources: report.derived_write_resources.length,
        });
      } catch (error) {
        logOrchestratorEvent(input.orchestratorLog, "task.lock_derivation.error", {
          taskId: task.manifest.id,
          task_slug: task.slug,
          message: formatErrorMessage(error),
        });
      }
    }
  } finally {
    await snapshot.release();
  }

  return reports;
}

function buildTaskLockResolver(input: {
  lockMode: ControlPlaneLockMode;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  fallbackResource: string;
}): LockResolver {
  if (input.lockMode !== "derived") {
    return (task) => normalizeLocks(task.manifest.locks);
  }

  const fallbackResource = input.fallbackResource.trim();
  const fallbackLocks = normalizeLocks({
    reads: [],
    writes: fallbackResource ? [fallbackResource] : [],
  });

  return (task) => {
    const report = input.derivedScopeReports.get(task.manifest.id);
    if (!report) {
      return fallbackLocks;
    }

    const derivedLocks = report.derived_locks ?? {
      reads: [],
      writes: report.derived_write_resources,
    };

    if (report.confidence !== "low" || fallbackResource.length === 0) {
      return normalizeLocks(derivedLocks);
    }

    const widenedWrites = new Set(derivedLocks.writes);
    widenedWrites.add(fallbackResource);

    return normalizeLocks({
      reads: derivedLocks.reads,
      writes: Array.from(widenedWrites),
    });
  };
}



// =============================================================================
// BLAST RADIUS
// =============================================================================

type BlastRadiusContext = {
  baseSha: string;
  model: ControlPlaneModel;
};

async function loadBlastRadiusContext(input: {
  controlPlaneConfig: ControlPlaneRunConfig;
  controlPlaneSnapshot: ControlPlaneSnapshot | undefined;
}): Promise<BlastRadiusContext | null> {
  const loadedModel = await loadControlPlaneModel({
    enabled: input.controlPlaneConfig.enabled,
    snapshot: input.controlPlaneSnapshot,
  });

  if (!loadedModel) {
    return null;
  }

  return { baseSha: loadedModel.baseSha, model: loadedModel.model };
}

async function emitBlastRadiusReport(input: {
  repoPath: string;
  runId: string;
  task: TaskSpec;
  workspacePath: string;
  blastContext: BlastRadiusContext;
  orchestratorLog: JsonlLogger;
}): Promise<ControlPlaneBlastRadiusReport | null> {
  const changedFiles = await listChangedFiles(
    input.workspacePath,
    input.blastContext.baseSha,
  );
  const report = buildBlastRadiusReport({
    task: input.task.manifest,
    baseSha: input.blastContext.baseSha,
    changedFiles,
    model: input.blastContext.model,
  });
  const reportPath = taskBlastReportPath(
    input.repoPath,
    input.runId,
    input.task.manifest.id,
  );

  await writeJsonFile(reportPath, report);

  logOrchestratorEvent(input.orchestratorLog, "task.blast_radius", {
    taskId: input.task.manifest.id,
    task_slug: input.task.slug,
    report_path: reportPath,
    confidence: report.confidence,
    touched_components: report.touched_components.length,
    impacted_components: report.impacted_components.length,
  });

  return report;
}



// =============================================================================
// POLICY DECISIONS
// =============================================================================

type TaskPolicyDecisionResult = {
  policyDecision: PolicyDecision;
  checksetDecision: ChecksetDecision;
  checksetReport: ChecksetReport;
  doctorCommand: string;
};

function computeTaskPolicyDecision(input: {
  task: TaskSpec;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  componentResourcePrefix: string;
  blastContext: BlastRadiusContext | null;
  checksConfig: ControlPlaneChecksRunConfig;
  defaultDoctorCommand: string;
  surfacePatterns: SurfacePatternSet;
  fallbackResource: string;
}): TaskPolicyDecisionResult {
  const derivedScopeReport =
    input.derivedScopeReports.get(input.task.manifest.id) ?? null;
  const result = evaluateTaskPolicyDecision({
    task: input.task.manifest,
    derivedScopeReport,
    componentResourcePrefix: input.componentResourcePrefix,
    fallbackResource: input.fallbackResource,
    model: input.blastContext?.model ?? null,
    checksConfig: input.checksConfig,
    defaultDoctorCommand: input.defaultDoctorCommand,
    surfacePatterns: input.surfacePatterns,
  });

  return {
    policyDecision: result.policyDecision,
    checksetDecision: result.checksetDecision,
    checksetReport: result.checksetReport,
    doctorCommand: result.doctorCommand,
  };
}

function resolveCompliancePolicyForTier(input: {
  basePolicy: ManifestEnforcementPolicy;
  tier?: PolicyDecision["tier"];
}): ManifestEnforcementPolicy {
  if (input.basePolicy === "off" || input.basePolicy === "block") {
    return input.basePolicy;
  }

  return (input.tier ?? 0) >= 2 ? "block" : "warn";
}



// =============================================================================
// RUN METRICS
// =============================================================================

type RunMetrics = {
  scopeViolations: {
    warnCount: number;
    blockCount: number;
  };
  fallbackRepoRootCount: number;
  blastRadius: {
    impactedComponentsTotal: number;
    reports: number;
  };
  validation: {
    doctorMsTotal: number;
    checksetMsTotal: number;
  };
};

type RunSummaryMetrics = {
  scope_violations: {
    warn_count: number;
    block_count: number;
  };
  fallback_repo_root_count: number;
  avg_impacted_components: number;
  doctor_seconds_total: number;
  checkset_seconds_total: number;
  derived_lock_mode_enabled: boolean;
  avg_batch_size: number;
};

type RunSummary = {
  run_id: string;
  project: string;
  status: RunState["status"];
  started_at: string;
  completed_at: string;
  control_plane: {
    enabled: boolean;
    lock_mode: ControlPlaneLockMode;
    scope_mode: ControlPlaneScopeMode;
  };
  metrics: RunSummaryMetrics;
};

function createRunMetrics(input: {
  derivedScopeReports: Map<string, DerivedScopeReport>;
  fallbackResource: string;
}): RunMetrics {
  return {
    scopeViolations: { warnCount: 0, blockCount: 0 },
    fallbackRepoRootCount: countFallbackRepoRoot(input.derivedScopeReports, input.fallbackResource),
    blastRadius: { impactedComponentsTotal: 0, reports: 0 },
    validation: { doctorMsTotal: 0, checksetMsTotal: 0 },
  };
}

function countFallbackRepoRoot(
  reports: Map<string, DerivedScopeReport>,
  fallbackResource: string,
): number {
  const fallback = fallbackResource.trim();
  if (!fallback) return 0;

  let count = 0;
  for (const report of reports.values()) {
    if (report.confidence !== "low") continue;
    if (report.derived_write_resources.includes(fallback)) {
      count += 1;
    }
  }

  return count;
}

function recordScopeViolations(metrics: RunMetrics, result: ManifestComplianceResult): void {
  if (result.violations.length === 0) return;

  if (result.status === "warn") {
    metrics.scopeViolations.warnCount += result.violations.length;
    return;
  }

  if (result.status === "block") {
    metrics.scopeViolations.blockCount += result.violations.length;
  }
}

function recordBlastRadius(
  metrics: RunMetrics,
  report: ControlPlaneBlastRadiusReport,
): void {
  metrics.blastRadius.impactedComponentsTotal += report.impacted_components.length;
  metrics.blastRadius.reports += 1;
}

function recordDoctorDuration(metrics: RunMetrics, durationMs: number): void {
  metrics.validation.doctorMsTotal += Math.max(0, durationMs);
}

function recordChecksetDuration(metrics: RunMetrics, durationMs: number): void {
  metrics.validation.checksetMsTotal += Math.max(0, durationMs);
}

function buildRunSummary(input: {
  runId: string;
  projectName: string;
  state: RunState;
  lockMode: ControlPlaneLockMode;
  scopeMode: ControlPlaneScopeMode;
  controlPlaneEnabled: boolean;
  metrics: RunMetrics;
}): RunSummary {
  const totalBatchTasks = input.state.batches.reduce(
    (sum, batch) => sum + batch.tasks.length,
    0,
  );
  const avgBatchSize = averageRounded(totalBatchTasks, input.state.batches.length, 2);
  const avgImpacted = averageRounded(
    input.metrics.blastRadius.impactedComponentsTotal,
    input.metrics.blastRadius.reports,
    2,
  );

  return {
    run_id: input.runId,
    project: input.projectName,
    status: input.state.status,
    started_at: input.state.started_at,
    completed_at: input.state.updated_at,
    control_plane: {
      enabled: input.controlPlaneEnabled,
      lock_mode: input.lockMode,
      scope_mode: input.scopeMode,
    },
    metrics: {
      scope_violations: {
        warn_count: input.metrics.scopeViolations.warnCount,
        block_count: input.metrics.scopeViolations.blockCount,
      },
      fallback_repo_root_count: input.metrics.fallbackRepoRootCount,
      avg_impacted_components: avgImpacted,
      doctor_seconds_total: secondsFromMs(input.metrics.validation.doctorMsTotal),
      checkset_seconds_total: secondsFromMs(input.metrics.validation.checksetMsTotal),
      derived_lock_mode_enabled: input.lockMode === "derived",
      avg_batch_size: avgBatchSize,
    },
  };
}

function averageRounded(total: number, count: number, decimals: number): number {
  if (count === 0) return 0;
  return roundToDecimals(total / count, decimals);
}

function secondsFromMs(durationMs: number): number {
  return roundToDecimals(durationMs / 1000, 3);
}

function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<RunResult> {
  const stopController = buildStopController(opts.stopSignal);

  try {
    const isResume = opts.resume ?? false;
    let runId: string;

    if (isResume) {
      const resolvedRunId = opts.runId ?? (await findLatestRunId(projectName));
      if (!resolvedRunId) {
        throw new Error(`No runs found to resume for project ${projectName}.`);
      }
      runId = resolvedRunId;
    } else {
      runId = opts.runId ?? defaultRunId();
    }
    const maxParallel = opts.maxParallel ?? config.max_parallel;
    const cleanupOnSuccess = opts.cleanupOnSuccess ?? false;
    const useDocker = opts.useDocker ?? true;
    const stopContainersOnExit = opts.stopContainersOnExit ?? false;
    const plannedBatches: BatchPlanEntry[] = [];
    const crashAfterContainerStart =
      process.env.MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START === "1";

    const repoPath = config.repo_path;
    const tasksRootAbs = path.join(repoPath, config.tasks_dir);
    const tasksDirPosix = config.tasks_dir.split(path.sep).join(path.posix.sep);
    const workerImage = config.docker.image;
    const containerResources = buildContainerResources(config.docker);
    const containerSecurityPayload = buildContainerSecurityPayload(config.docker);
    const networkMode = config.docker.network_mode;
    const containerUser = config.docker.user;
    let controlPlaneConfig = resolveControlPlaneConfig(config);
    let lockMode: ControlPlaneLockMode;
    let scopeComplianceMode: ControlPlaneScopeMode;
    let shouldEnforceCompliance: boolean;
    let compliancePolicy: ManifestEnforcementPolicy;
    const docker = useDocker ? dockerClient() : null;
    const manifestPolicy: ManifestEnforcementPolicy = config.manifest_enforcement ?? "warn";
    const costPer1kTokens = DEFAULT_COST_PER_1K_TOKENS;
    const mockLlmMode = isMockLlmEnabled() || config.worker.model === "mock";
    let stopRequested: StopRequest | null = null;
    let state!: RunState;

    // Prepare directories
    await ensureDir(orchestratorHome());
    const stateStore = new StateStore(projectName, runId);
    const orchLog = new JsonlLogger(orchestratorLogPath(projectName, runId), { runId });
    const testValidatorConfig = config.test_validator;
    const testValidatorMode = resolveValidatorMode(testValidatorConfig);
    const testValidatorEnabled = testValidatorMode !== "off";
    const doctorValidatorConfig = config.doctor_validator;
    const doctorValidatorMode = resolveValidatorMode(doctorValidatorConfig);
    const doctorValidatorEnabled = doctorValidatorMode !== "off";
    let testValidatorLog: JsonlLogger | null = null;
    let doctorValidatorLog: JsonlLogger | null = null;
    const closeValidatorLogs = (): void => {
      if (testValidatorLog) {
        testValidatorLog.close();
      }
      if (doctorValidatorLog) {
        doctorValidatorLog.close();
      }
    };

    logOrchestratorEvent(orchLog, "run.start", {
      project: projectName,
      repo_path: repoPath,
    });

    // Ensure repo is clean and on integration branch.
    await ensureCleanWorkingTree(repoPath);
    await checkout(repoPath, config.main_branch).catch(async () => {
      // If branch doesn't exist, create it from current HEAD.
      await execa("git", ["checkout", "-b", config.main_branch], {
        cwd: repoPath,
        stdio: "pipe",
      });
    });

  const runResumeReason = isResume ? "resume_command" : "existing_state";
  const hadExistingState = await stateStore.exists();
  if (hadExistingState) {
    state = await stateStore.load();

    if (state.status !== "running") {
      logRunResume(orchLog, { status: state.status, reason: runResumeReason });
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_not_running" });
      closeValidatorLogs();
      orchLog.close();
      return { runId, state, plan: plannedBatches };
    }
  } else if (isResume) {
    logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_missing" });
    orchLog.close();
    throw new Error(`Cannot resume run ${runId}: state file not found.`);
  }

  let controlPlaneSnapshot: ControlPlaneSnapshot | undefined = hadExistingState
    ? state.control_plane
    : undefined;
  const snapshotEnabled = controlPlaneSnapshot?.enabled ?? controlPlaneConfig.enabled;
  if (!controlPlaneSnapshot?.base_sha) {
    const baseSha = await resolveRunBaseSha(repoPath, config.main_branch);
    controlPlaneSnapshot = {
      enabled: snapshotEnabled,
      base_sha: baseSha,
    };

    if (hadExistingState) {
      state.control_plane = controlPlaneSnapshot;
      await stateStore.save(state);
    } else {
      state = createRunState({
        runId,
        project: projectName,
        repoPath,
        mainBranch: config.main_branch,
        taskIds: [],
        controlPlane: controlPlaneSnapshot,
      });
      await stateStore.save(state);
    }
  } else if (!hadExistingState) {
    state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: [],
      controlPlane: controlPlaneSnapshot,
    });
    await stateStore.save(state);
  }

  if (shouldBuildControlPlaneSnapshot(controlPlaneSnapshot)) {
    controlPlaneSnapshot = await buildControlPlaneSnapshot({
      repoPath,
      baseSha: controlPlaneSnapshot.base_sha,
      enabled: true,
    });
    state.control_plane = controlPlaneSnapshot;
    await stateStore.save(state);
  }

  if (controlPlaneSnapshot && controlPlaneSnapshot.enabled !== controlPlaneConfig.enabled) {
    controlPlaneConfig = {
      ...controlPlaneConfig,
      enabled: controlPlaneSnapshot.enabled,
    };
  }

  lockMode = resolveEffectiveLockMode(controlPlaneConfig);
  scopeComplianceMode = resolveScopeComplianceMode(controlPlaneConfig);
  shouldEnforceCompliance = scopeComplianceMode === "enforce";
  compliancePolicy = scopeComplianceMode === "off" ? "off" : manifestPolicy;

  const resourceContext = await buildResourceResolutionContext({
    repoPath,
    controlPlaneConfig,
    controlPlaneSnapshot,
    staticResources: config.resources,
  });

  // Load tasks.
  let tasks: TaskSpec[];
  try {
    const res = await loadTaskSpecs(repoPath, config.tasks_dir, {
      knownResources: resourceContext.knownResources,
    });
    tasks = res.tasks;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logOrchestratorEvent(orchLog, "run.tasks_invalid", { message });
    closeValidatorLogs();
    orchLog.close();
    throw err;
  }
  if (opts.tasks && opts.tasks.length > 0) {
    const allow = new Set(opts.tasks);
    tasks = tasks.filter((t) => allow.has(t.manifest.id));
  }

  if (tasks.length === 0) {
    logOrchestratorEvent(orchLog, "run.no_tasks");
    closeValidatorLogs();
    orchLog.close();
    return {
      runId,
      state,
      plan: plannedBatches,
    };
  }

  const blastContext = await loadBlastRadiusContext({
    controlPlaneConfig,
    controlPlaneSnapshot,
  });
  const derivedScopeReports = await emitDerivedScopeReports({
    repoPath,
    runId,
    tasks,
    controlPlaneConfig,
    controlPlaneSnapshot,
    orchestratorLog: orchLog,
  });
  const runMetrics = createRunMetrics({
    derivedScopeReports,
    fallbackResource: controlPlaneConfig.fallbackResource,
  });
  const policyDecisions = new Map<string, PolicyDecision>();
  const lockResolver = buildTaskLockResolver({
    lockMode,
    derivedScopeReports,
    fallbackResource: controlPlaneConfig.fallbackResource,
  });

  if (testValidatorEnabled) {
    testValidatorLog = new JsonlLogger(validatorLogPath(projectName, runId, "test-validator"), {
      runId,
    });
  }
  if (doctorValidatorEnabled) {
    doctorValidatorLog = new JsonlLogger(
      validatorLogPath(projectName, runId, "doctor-validator"),
      { runId },
    );
  }

  logOrchestratorEvent(orchLog, "run.tasks_loaded", {
    total_tasks: tasks.length,
    requested_tasks: opts.tasks?.length ?? null,
  });

  // Ensure worker image exists.
  if (useDocker) {
    const shouldBuildImage = opts.buildImage ?? true;
    if (shouldBuildImage) {
      logOrchestratorEvent(orchLog, "docker.image.build.start", { image: workerImage });
      await buildWorkerImage({
        tag: workerImage,
        dockerfile: config.docker.dockerfile,
        context: config.docker.build_context,
      });
      logOrchestratorEvent(orchLog, "docker.image.build.complete", { image: workerImage });
    } else {
      const haveImage = docker ? await imageExists(docker, workerImage) : false;
      if (!haveImage) {
        throw new Error(
          `Docker image not found: ${workerImage}. Build it or run with --build-image.`,
        );
      }
    }
  }

  // Create or resume run state
  const backfillUsageFromLogs = (): boolean => {
    let updated = false;
    const beforeTokens = state.tokens_used ?? 0;
    const beforeCost = state.estimated_cost ?? 0;
    for (const task of tasks) {
      const taskState = state.tasks[task.manifest.id];
      if (!taskState) continue;

      const hasUsage =
        (taskState.tokens_used ?? 0) > 0 ||
        (taskState.usage_by_attempt && taskState.usage_by_attempt.length > 0);
      if (hasUsage) continue;

      const update = refreshTaskUsage(task.manifest.id, task.slug);
      if (update) {
        updated = true;
      }
    }

    const totals = recomputeRunUsage(state);
    if (totals.tokensUsed !== beforeTokens || totals.estimatedCost !== beforeCost) {
      updated = true;
    }
    return updated;
  };
  // Ensure new tasks found in the manifest are tracked for this run.
  for (const t of tasks) {
    if (!state.tasks[t.manifest.id]) {
      state.tasks[t.manifest.id] = {
        status: "pending",
        attempts: 0,
        checkpoint_commits: [],
        validator_results: [],
        human_review: undefined,
        tokens_used: 0,
        estimated_cost: 0,
        usage_by_attempt: [],
      };
    }
  }
  await stateStore.save(state);

  if (hadExistingState) {
    const usageBackfilled = backfillUsageFromLogs();
    if (usageBackfilled) {
      await stateStore.save(state);
    }

    const runningTasks = Object.values(state.tasks).filter((t) => t.status === "running").length;
    logRunResume(orchLog, {
      status: state.status,
      reason: runResumeReason,
      runningTasks,
    });
  }

  const resolveStopReason = (): StopRequest | null => {
    if (stopRequested) return stopRequested;
    const reason = stopController.reason;
    if (reason) {
      stopRequested = reason;
    }
    return stopRequested;
  };

  const stopIfRequested = async (): Promise<RunResult | null> => {
    const reason = resolveStopReason();
    if (!reason) return null;
    return await stopRun(reason);
  };

  async function stopRun(reason: StopRequest): Promise<RunResult> {
    const containerAction: RunStopInfo["containers"] =
      stopContainersOnExit && useDocker && docker ? "stopped" : "left_running";
    const stopSummary =
      stopContainersOnExit && useDocker && docker ? await stopRunContainers() : null;
    state.status = "running";

    const payload: JsonObject = {
      reason: reason.kind,
      stop_containers_requested: stopContainersOnExit,
      containers: containerAction,
    };
    if (reason.signal) payload.signal = reason.signal;
    if (stopSummary) {
      payload.containers_stopped = stopSummary.stopped;
      if (stopSummary.errors > 0) {
        payload.container_stop_errors = stopSummary.errors;
      }
    }

    logOrchestratorEvent(orchLog, "run.stop", payload);
    await stateStore.save(state);
    closeValidatorLogs();
    orchLog.close();

    return {
      runId,
      state,
      plan: plannedBatches,
      stopped: {
        reason: "signal",
        signal: reason.signal,
        containers: containerAction,
        stopContainersRequested: stopContainersOnExit,
        stoppedContainers: stopSummary?.stopped,
        stopErrors: stopSummary?.errors ? stopSummary.errors : undefined,
      },
    };
  }

  async function stopRunContainers(): Promise<{ stopped: number; errors: number }> {
    if (!docker) return { stopped: 0, errors: 0 };

    const containers = await docker.listContainers({ all: true });
    const matches = containers.filter(
      (c) =>
        containerLabel(c.Labels, "project") === projectName &&
        containerLabel(c.Labels, "run_id") === runId,
    );

    let stopped = 0;
    let errors = 0;

    for (const c of matches) {
      const containerName = firstContainerName(c.Names);
      const taskId = containerLabel(c.Labels, "task_id");

      try {
        const container = docker.getContainer(c.Id);
        try {
          await container.stop({ t: 5 });
        } catch {
          // best-effort stop; continue to removal
        }
        await removeContainer(container);
        stopped += 1;
        const payload: JsonObject & { taskId?: string } = {
          container_id: c.Id,
          ...(containerName ? { name: containerName } : {}),
        };
        if (taskId) payload.taskId = taskId;
        logOrchestratorEvent(orchLog, "container.stop", payload);
      } catch (err) {
        errors += 1;
        const payload: JsonObject & { taskId?: string } = {
          container_id: c.Id,
          ...(containerName ? { name: containerName } : {}),
          message: formatErrorMessage(err),
        };
        if (taskId) payload.taskId = taskId;
        logOrchestratorEvent(orchLog, "container.stop_failed", payload);
      }
    }

    return { stopped, errors };
  }

  const earlyStop = await stopIfRequested();
  if (earlyStop) return earlyStop;

  // Main loop helpers
  let { completed, failed } = buildStatusSets(state);
  const doctorValidatorRunEvery = doctorValidatorConfig?.run_every_n_tasks;
  let doctorValidatorLastCount = completed.size + failed.size;
  let lastIntegrationDoctorOutput: string | undefined;
  let lastIntegrationDoctorExitCode: number | undefined;
  let lastIntegrationDoctorCanary: DoctorCanaryResult | undefined;

  const refreshStatusSets = (): void => {
    const sets = buildStatusSets(state);
    completed = sets.completed;
    failed = sets.failed;
  };

  const findRunningBatch = (): (typeof state.batches)[number] | null => {
    const activeBatch = state.batches.find((b) => b.status === "running");
    if (activeBatch) return activeBatch;

    const runningTaskEntry = Object.entries(state.tasks).find(([, t]) => t.status === "running");
    if (!runningTaskEntry) return null;

    const batchId = state.tasks[runningTaskEntry[0]].batch_id;
    if (batchId === undefined) return null;

    return state.batches.find((b) => b.batch_id === batchId) ?? null;
  };

  const resolveTaskMeta = (
    task: TaskSpec,
  ): { branchName: string; workspace: string; logsDir: string } => {
    const taskId = task.manifest.id;
    const taskState = state.tasks[taskId];
    if (!taskState) {
      throw new Error(`Unknown task in state: ${taskId}`);
    }

    const branchName =
      taskState.branch ??
      buildTaskBranchName(config.task_branch_prefix, taskId, task.manifest.name);
    const workspace = taskState.workspace ?? taskWorkspaceDir(projectName, runId, taskId);
    const logsDir = taskState.logs_dir ?? taskLogsDir(projectName, runId, taskId, task.slug);

    taskState.branch = branchName;
    taskState.workspace = workspace;
    taskState.logs_dir = logsDir;

    return { branchName, workspace, logsDir };
  };

  const syncWorkerStateIntoTask = async (
    taskId: string,
    workspace: string,
  ): Promise<boolean> => {
    try {
      const workerState = await loadWorkerState(workspace);
      if (!workerState) return false;

      const taskState = state.tasks[taskId];
      if (!taskState) return false;

      let changed = false;

      if (workerState.thread_id && taskState.thread_id !== workerState.thread_id) {
        taskState.thread_id = workerState.thread_id;
        changed = true;
      }

      const mergedCheckpoints = mergeCheckpointCommits(
        taskState.checkpoint_commits ?? [],
        workerState.checkpoints ?? [],
      );
      if (!checkpointListsEqual(taskState.checkpoint_commits ?? [], mergedCheckpoints)) {
        taskState.checkpoint_commits = mergedCheckpoints;
        changed = true;
      }

      return changed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logOrchestratorEvent(orchLog, "worker.state.read_error", { taskId, message });
      return false;
    }
  };

  function refreshTaskUsage(taskId: string, taskSlug: string): TaskUsageUpdate | null {
    const taskState = state.tasks[taskId];
    if (!taskState) return null;

    const previousTokens = taskState.tokens_used ?? 0;
    const previousCost = taskState.estimated_cost ?? 0;
    const eventsPath = taskEventsLogPath(projectName, runId, taskId, taskSlug);
    const usage = parseTaskTokenUsage(eventsPath, costPer1kTokens);

    taskState.usage_by_attempt = usage.attempts;
    taskState.tokens_used = usage.tokensUsed;
    taskState.estimated_cost = usage.estimatedCost;

    return { taskId, previousTokens, previousCost, usage };
  }

  const logBudgetBreaches = (
    breaches: ReturnType<typeof detectBudgetBreaches>,
  ): "budget_block" | undefined => {
    let stop: "budget_block" | undefined;

    for (const breach of breaches) {
      const payload: JsonObject = {
        scope: breach.scope,
        kind: breach.kind,
        limit: breach.limit,
        value: breach.value,
        mode: breach.mode,
      };
      if (breach.taskId) {
        payload.task_id = breach.taskId;
      }

      const eventType = breach.mode === "block" ? "budget.block" : "budget.warn";
      logOrchestratorEvent(orchLog, eventType, payload);

      if (breach.mode === "block") {
        stop = "budget_block";
      }
    }

    return stop;
  };

  const buildSuccessfulTaskSummaries = (batchTasks: TaskSpec[]): TaskSuccessResult[] => {
    const summaries: TaskSuccessResult[] = [];
    for (const task of batchTasks) {
      const taskState = state.tasks[task.manifest.id];
      if (!taskState || taskState.status !== "complete") continue;

      const meta = resolveTaskMeta(task);
      summaries.push({
        success: true,
        taskId: task.manifest.id,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
      });
    }
    return summaries;
  };

  const findTaskContainer = async (
    taskId: string,
    containerIdHint?: string,
  ): Promise<{ id: string; name?: string } | null> => {
    if (!docker) return null;

    const containers = await docker.listContainers({ all: true });
    const matches = containers.filter(
      (c) =>
        containerLabel(c.Labels, "project") === projectName &&
        containerLabel(c.Labels, "run_id") === runId,
    );

    const byTask = matches.find((c) => containerLabel(c.Labels, "task_id") === taskId);
    if (byTask) {
      return { id: byTask.Id, name: firstContainerName(byTask.Names) };
    }

    if (containerIdHint) {
      const byId = matches.find(
        (c) => c.Id === containerIdHint || c.Id.startsWith(containerIdHint),
      );
      if (byId) {
        return { id: byId.Id, name: firstContainerName(byId.Names) };
      }

      try {
        const inspected = await docker.getContainer(containerIdHint).inspect();
        return {
          id: inspected.Id ?? containerIdHint,
          name: firstContainerName([inspected.Name]),
        };
      } catch {
        // ignore
      }
    }

    return null;
  };

  async function resumeRunningTask(task: TaskSpec): Promise<TaskRunResult> {
    const taskId = task.manifest.id;
    const taskState = state.tasks[taskId];
    const meta = resolveTaskMeta(task);

    await syncWorkerStateIntoTask(taskId, meta.workspace);

    if (!useDocker || !docker) {
      const reason = "Docker unavailable on resume; resetting running task to pending";
      logTaskReset(orchLog, taskId, reason);
      return {
        success: false,
        taskId,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
        errorMessage: reason,
        resetToPending: true,
      };
    }

    const containerInfo = await findTaskContainer(taskId, taskState?.container_id);
    if (!containerInfo) {
      const reason = "Task container missing on resume";
      const payload: Record<string, string> = { taskId };
      if (taskState?.container_id) {
        payload.container_id = taskState.container_id;
      }
      logOrchestratorEvent(orchLog, "container.missing", payload);
      logTaskReset(orchLog, taskId, reason);
      return {
        success: false,
        taskId,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
        errorMessage: reason,
        resetToPending: true,
      };
    }

    let logStream: LogStreamHandle | undefined;
    const taskEventsPath = taskEventsLogPath(projectName, runId, taskId, task.slug);
    await ensureDir(path.dirname(taskEventsPath));
    const taskEvents = new JsonlLogger(taskEventsPath, { runId, taskId });

    try {
      const container = docker.getContainer(containerInfo.id);
      const inspect = await container.inspect();
      const isRunning = inspect.State?.Running ?? false;
      const containerId = inspect.Id ?? containerInfo.id;

      taskState.container_id = containerId;

      logStream = await streamContainerLogs(container, taskEvents, {
        fallbackType: "task.log",
        includeHistory: true,
        follow: true,
      });

      logOrchestratorEvent(orchLog, "container.reattach", {
        taskId,
        container_id: containerId,
        ...(containerInfo.name ? { name: containerInfo.name } : {}),
        running: isRunning,
      });

      const waited = await waitContainer(container);

      logOrchestratorEvent(
        orchLog,
        isRunning ? "container.exit" : "container.exited-on-resume",
        { taskId, container_id: containerId, exit_code: waited.exitCode },
      );

      if (cleanupOnSuccess && waited.exitCode === 0) {
        await removeContainer(container);
      }

      await syncWorkerStateIntoTask(taskId, meta.workspace);

      if (waited.exitCode === 0) {
        return {
          success: true,
          taskId,
          taskSlug: task.slug,
          branchName: meta.branchName,
          workspace: meta.workspace,
          logsDir: meta.logsDir,
        };
      }

      return {
        success: false,
        taskId,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
        errorMessage: `Task worker container exited with code ${waited.exitCode}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTaskReset(orchLog, taskId, message);
      return {
        success: false,
        taskId,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
        errorMessage: message,
        resetToPending: true,
      };
    } finally {
      if (logStream) {
        try {
          logStream.detach();
          await logStream.completed.catch(() => undefined);
        } catch {
          // ignore
        }
      }
      taskEvents.close();
    }
  }

  function logComplianceEvents(args: {
    taskId: string;
    taskSlug: string;
    policy: ManifestEnforcementPolicy;
    scopeMode: ControlPlaneScopeMode;
    reportPath: string;
    result: ManifestComplianceResult;
  }): void {
    recordScopeViolations(runMetrics, args.result);
    const basePayload = {
      task_slug: args.taskSlug,
      policy: args.policy,
      scope_mode: args.scopeMode,
      status: args.result.status,
      report_path: args.reportPath,
      changed_files: args.result.changedFiles.length,
      violations: args.result.violations.length,
    };

    const eventType =
      args.result.status === "skipped"
        ? "manifest.compliance.skip"
        : args.result.violations.length === 0
          ? "manifest.compliance.pass"
          : args.result.status === "block"
            ? "manifest.compliance.block"
            : "manifest.compliance.warn";

    logOrchestratorEvent(orchLog, eventType, { taskId: args.taskId, ...basePayload });

    if (args.result.violations.length === 0) return;

    for (const violation of args.result.violations) {
      logOrchestratorEvent(orchLog, "access.requested", {
        taskId: args.taskId,
        task_slug: args.taskSlug,
        file: violation.path,
        resources: violation.resources,
        reasons: violation.reasons,
        ...(violation.component_owners
          ? { component_owners: violation.component_owners }
          : {}),
        ...(violation.guidance ? { guidance: violation.guidance } : {}),
        policy: args.policy,
        enforcement: args.result.status,
        report_path: args.reportPath,
      });
    }
  }

  function describeManifestViolations(result: ManifestComplianceResult): string {
    const count = result.violations.length;
    const example = result.violations[0]?.path;
    const detail = example ? ` (example: ${example})` : "";
    return `${count} undeclared access request(s)${detail}`;
  }

  function buildManifestBlockReason(result: ManifestComplianceResult): string {
    return `Manifest enforcement blocked: ${describeManifestViolations(result)}`;
  }

  async function finalizeBatch(params: {
    batchId: number;
    batchTasks: TaskSpec[];
    results: TaskRunResult[];
  }): Promise<
    | "merge_conflict"
    | "integration_doctor_failed"
    | "manifest_enforcement_blocked"
    | "validator_blocked"
    | "budget_block"
    | undefined
  > {
    const runUsageBefore = {
      tokensUsed: state.tokens_used ?? 0,
      estimatedCost: state.estimated_cost ?? 0,
    };
    const usageUpdates: TaskUsageUpdate[] = [];
    for (const result of params.results) {
      const update = refreshTaskUsage(result.taskId, result.taskSlug);
      if (update) {
        usageUpdates.push(update);
      }
    }
    const runUsageAfter = recomputeRunUsage(state);

    const hadPendingResets = params.results.some((r) => !r.success && r.resetToPending);
    const rescopeFailures: { taskId: string; reason: string }[] = [];
    let doctorCanaryResult: DoctorCanaryResult | undefined;
    for (const r of params.results) {
      const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);

      if (blastContext && taskSpec) {
        try {
          const report = await emitBlastRadiusReport({
            repoPath,
            runId,
            task: taskSpec,
            workspacePath: r.workspace,
            blastContext,
            orchestratorLog: orchLog,
          });
          if (report) {
            recordBlastRadius(runMetrics, report);
          }
        } catch (error) {
          logOrchestratorEvent(orchLog, "task.blast_radius.error", {
            taskId: r.taskId,
            task_slug: taskSpec.slug,
            message: formatErrorMessage(error),
          });
        }
      }

      if (!r.success) {
        if (r.resetToPending) {
          const reason = r.errorMessage ?? "Task reset to pending";
          resetTaskToPending(state, r.taskId, reason);
          logTaskReset(orchLog, r.taskId, reason);
        } else {
          const errorMessage = r.errorMessage ?? "Task worker exited with a non-zero status";
          markTaskFailed(state, r.taskId, errorMessage);
          logOrchestratorEvent(orchLog, "task.failed", {
            taskId: r.taskId,
            attempts: state.tasks[r.taskId].attempts,
            message: errorMessage,
          });
        }
        continue;
      }

      if (!taskSpec) {
        const message = "Task spec missing during finalizeBatch";
        markTaskFailed(state, r.taskId, message);
        logOrchestratorEvent(orchLog, "task.failed", {
          taskId: r.taskId,
          attempts: state.tasks[r.taskId].attempts,
          message,
        });
        continue;
      }

      const complianceReportPath = taskComplianceReportPath(
        projectName,
        runId,
        r.taskId,
        r.taskSlug,
      );
      const policyDecision = policyDecisions.get(r.taskId);
      const effectiveCompliancePolicy = resolveCompliancePolicyForTier({
        basePolicy: compliancePolicy,
        tier: policyDecision?.tier,
      });
      const compliance = await runManifestCompliance({
        workspacePath: r.workspace,
        mainBranch: config.main_branch,
        manifest: taskSpec.manifest,
        resources: resourceContext.effectiveResources,
        staticResources: resourceContext.staticResources,
        fallbackResource: resourceContext.fallbackResource,
        ownerResolver: resourceContext.ownerResolver,
        ownershipResolver: resourceContext.ownershipResolver,
        resourcesMode: resourceContext.resourcesMode,
        policy: effectiveCompliancePolicy,
        reportPath: complianceReportPath,
      });

      logComplianceEvents({
        taskId: r.taskId,
        taskSlug: r.taskSlug,
        policy: effectiveCompliancePolicy,
        scopeMode: scopeComplianceMode,
        reportPath: complianceReportPath,
        result: compliance,
      });

      if (compliance.violations.length > 0 && shouldEnforceCompliance) {
        const violationSummary = describeManifestViolations(compliance);
        const rescopeReason = `Rescope required: ${violationSummary}`;
        markTaskRescopeRequired(state, r.taskId, rescopeReason);
        logOrchestratorEvent(orchLog, "task.rescope.start", {
          taskId: r.taskId,
          violations: compliance.violations.length,
          report_path: complianceReportPath,
          policy: effectiveCompliancePolicy,
        });

        const rescope = computeRescopeFromCompliance(taskSpec.manifest, compliance);
        if (rescope.status === "updated") {
          await writeJsonFile(taskSpec.manifestPath, rescope.manifest);
          taskSpec.manifest = rescope.manifest;

          const resetReason = `Rescoped manifest: +${rescope.addedLocks.length} locks, +${rescope.addedFiles.length} files`;
          resetTaskToPending(state, r.taskId, resetReason);
          logOrchestratorEvent(orchLog, "task.rescope.updated", {
            taskId: r.taskId,
            added_locks: rescope.addedLocks,
            added_files: rescope.addedFiles,
            manifest_path: taskSpec.manifestPath,
            report_path: complianceReportPath,
          });
          continue;
        }

        const failedReason = rescope.reason ?? rescopeReason;
        state.tasks[r.taskId].last_error = failedReason;
        logOrchestratorEvent(orchLog, "task.rescope.failed", {
          taskId: r.taskId,
          reason: failedReason,
          violations: compliance.violations.length,
          report_path: complianceReportPath,
        });
        rescopeFailures.push({ taskId: r.taskId, reason: failedReason });
        continue;
      }

      markTaskComplete(state, r.taskId);
      logOrchestratorEvent(orchLog, "task.complete", {
        taskId: r.taskId,
        attempts: state.tasks[r.taskId].attempts,
      });
    }

    if (rescopeFailures.length > 0) {
      state.status = "failed";
    }

    await stateStore.save(state);
    refreshStatusSets();

    const readyForValidation = buildSuccessfulTaskSummaries(params.batchTasks);
    const blockedTasks = new Set<string>();

    if (testValidatorEnabled && testValidatorConfig) {
      for (const r of readyForValidation) {
        const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);
        if (!taskSpec) continue;

        const reportPath = validatorReportPath(
          projectName,
          runId,
          "test-validator",
          r.taskId,
          r.taskSlug,
        );

        let testResult: TestValidationReport | null = null;
        let testError: string | null = null;
        const testStartedAt = Date.now();
        try {
          testResult = await runTestValidator({
            projectName,
            repoPath,
            runId,
            task: taskSpec,
            taskSlug: r.taskSlug,
            workspacePath: r.workspace,
            taskLogsDir: r.logsDir,
            mainBranch: config.main_branch,
            config: testValidatorConfig,
            orchestratorLog: orchLog,
            logger: testValidatorLog ?? undefined,
          });
        } catch (err) {
          testError = err instanceof Error ? err.message : String(err);
          logOrchestratorEvent(orchLog, "validator.error", {
            validator: "test",
            taskId: r.taskId,
            message: testError,
          });
        } finally {
          recordChecksetDuration(runMetrics, Date.now() - testStartedAt);
        }

        const outcome = await summarizeTestValidatorResult(reportPath, testResult, testError);
        const relativeReport = relativeReportPath(projectName, runId, outcome.reportPath);

        setValidatorResult(state, r.taskId, {
          validator: "test",
          status: outcome.status,
          mode: testValidatorMode,
          summary: outcome.summary ?? undefined,
          report_path: relativeReport,
        });

        if (shouldBlockValidator(testValidatorMode, outcome.status)) {
          blockedTasks.add(r.taskId);
          const reason =
            outcome.summary !== null && outcome.summary.trim().length > 0
              ? `Test validator blocked merge: ${outcome.summary}`
              : "Test validator blocked merge (mode=block)";
          markTaskNeedsHumanReview(state, r.taskId, {
            validator: "test",
            reason,
            summary: outcome.summary ?? undefined,
            reportPath: relativeReport,
          });
          logOrchestratorEvent(orchLog, "validator.block", {
            validator: "test",
            taskId: r.taskId,
            mode: testValidatorMode,
            status: outcome.status,
          });
        }
      }
    }

    await stateStore.save(state);
    refreshStatusSets();

    let batchMergeCommit: string | undefined;
    let integrationDoctorPassed: boolean | undefined;
    let stopReason:
      | "merge_conflict"
      | "integration_doctor_failed"
      | "manifest_enforcement_blocked"
      | "validator_blocked"
      | "budget_block"
      | undefined;

    const budgetBreaches = detectBudgetBreaches({
      budgets: config.budgets,
      taskUpdates: usageUpdates,
      runBefore: runUsageBefore,
      runAfter: runUsageAfter,
    });
    const budgetStop = budgetBreaches.length > 0 ? logBudgetBreaches(budgetBreaches) : undefined;
    if (budgetStop) {
      stopReason = budgetStop;
      state.status = "failed";
    }

    const finishedCount = completed.size + failed.size;
    const shouldRunDoctorValidatorCadence =
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      doctorValidatorRunEvery !== undefined &&
      finishedCount - doctorValidatorLastCount >= doctorValidatorRunEvery;

    if (
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      shouldRunDoctorValidatorCadence &&
      !stopReason
    ) {
      const doctorStartedAt = Date.now();
      const doctorOutcome = await runDoctorValidatorWithReport({
        projectName,
        repoPath,
        runId,
        mainBranch: config.main_branch,
        doctorCommand: config.doctor,
        doctorCanary: lastIntegrationDoctorCanary,
        trigger: "cadence",
        triggerNotes: `Cadence reached after ${finishedCount} tasks (interval ${doctorValidatorRunEvery})`,
        config: doctorValidatorConfig,
        orchestratorLog: orchLog,
        logger: doctorValidatorLog ?? undefined,
      });
      recordDoctorDuration(runMetrics, Date.now() - doctorStartedAt);
      doctorValidatorLastCount = finishedCount;

      if (doctorOutcome) {
        const relativeReport = relativeReportPath(projectName, runId, doctorOutcome.reportPath);
        const recipients = buildSuccessfulTaskSummaries(params.batchTasks);

        for (const r of recipients) {
          setValidatorResult(state, r.taskId, {
            validator: "doctor",
            status: doctorOutcome.status,
            mode: doctorValidatorMode,
            summary: doctorOutcome.summary ?? undefined,
            report_path: relativeReport,
            trigger: doctorOutcome.trigger,
          });

          if (shouldBlockValidator(doctorValidatorMode, doctorOutcome.status)) {
            blockedTasks.add(r.taskId);
            const reason =
              doctorOutcome.summary && doctorOutcome.summary.length > 0
                ? `Doctor validator blocked merge: ${doctorOutcome.summary}`
                : "Doctor validator blocked merge (mode=block)";
            markTaskNeedsHumanReview(state, r.taskId, {
              validator: "doctor",
              reason,
              summary: doctorOutcome.summary ?? undefined,
              reportPath: relativeReport,
            });
            logOrchestratorEvent(orchLog, "validator.block", {
              validator: "doctor",
              taskId: r.taskId,
              mode: doctorValidatorMode,
              status: doctorOutcome.status,
              trigger: doctorOutcome.trigger ?? "unknown",
            });
          }
        }
      }
    }

    if (blockedTasks.size > 0 && !stopReason) {
      stopReason = "validator_blocked";
      state.status = "failed";
    }

    await stateStore.save(state);
    refreshStatusSets();

    const successfulTasks = buildSuccessfulTaskSummaries(params.batchTasks);

    if (rescopeFailures.length > 0 && !stopReason) {
      stopReason = "manifest_enforcement_blocked";
    }

    if (successfulTasks.length > 0 && !stopReason) {
      logOrchestratorEvent(orchLog, "batch.merging", {
        batch_id: params.batchId,
        tasks: successfulTasks.map((r) => r.taskId),
      });

      const mergeResult = await mergeTaskBranches({
        repoPath,
        mainBranch: config.main_branch,
        branches: successfulTasks.map((r) => ({
          taskId: r.taskId,
          branchName: r.branchName,
          workspacePath: r.workspace,
        })),
      });

      if (mergeResult.status === "conflict") {
        batchMergeCommit = mergeResult.mergeCommit;
        logOrchestratorEvent(orchLog, "batch.merge_conflict", {
          batch_id: params.batchId,
          task_id: mergeResult.conflict.taskId,
          branch: mergeResult.conflict.branchName,
          message: mergeResult.message,
        });
        state.status = "failed";
        stopReason = "merge_conflict";
      } else {
        batchMergeCommit = mergeResult.mergeCommit;

        logOrchestratorEvent(orchLog, "doctor.integration.start", {
          batch_id: params.batchId,
          command: config.doctor,
        });
        const doctorIntegrationStartedAt = Date.now();
        const doctorRes = await execaCommand(config.doctor, {
          cwd: repoPath,
          shell: true,
          reject: false,
          timeout: config.doctor_timeout ? config.doctor_timeout * 1000 : undefined,
        });
        recordDoctorDuration(runMetrics, Date.now() - doctorIntegrationStartedAt);
        lastIntegrationDoctorOutput = `${doctorRes.stdout}\n${doctorRes.stderr}`.trim();
        const doctorExitCode = doctorRes.exitCode ?? -1;
        lastIntegrationDoctorExitCode = doctorExitCode;
        const doctorOk = doctorExitCode === 0;
        logOrchestratorEvent(
          orchLog,
          doctorOk ? "doctor.integration.pass" : "doctor.integration.fail",
          {
            batch_id: params.batchId,
            exit_code: doctorExitCode,
          },
        );
        integrationDoctorPassed = doctorOk;

        if (doctorOk) {
          logOrchestratorEvent(orchLog, "doctor.canary.start", { batch_id: params.batchId });
          const doctorCanaryStartedAt = Date.now();
          doctorCanaryResult = await runDoctorCanary({
            command: config.doctor,
            cwd: repoPath,
            timeoutSeconds: config.doctor_timeout,
          });
          recordDoctorDuration(runMetrics, Date.now() - doctorCanaryStartedAt);
          lastIntegrationDoctorCanary = doctorCanaryResult;

          if (doctorCanaryResult.status === "unexpected_pass") {
            logOrchestratorEvent(orchLog, "doctor.canary.failed", {
              batch_id: params.batchId,
              exit_code: doctorCanaryResult.exitCode,
              message: "Doctor exited 0 with ORCH_CANARY=1 (expected non-zero).",
              output_preview: doctorCanaryResult.output.slice(0, 500),
            });
          } else if (doctorCanaryResult.status === "expected_fail") {
            logOrchestratorEvent(orchLog, "doctor.canary.pass", {
              batch_id: params.batchId,
              exit_code: doctorCanaryResult.exitCode,
              output_preview: doctorCanaryResult.output.slice(0, 500),
            });
          }
        } else {
          doctorCanaryResult = { status: "skipped", reason: "Integration doctor failed" };
          lastIntegrationDoctorCanary = doctorCanaryResult;
        }

        if (!doctorOk) {
          state.status = "failed";
          stopReason = "integration_doctor_failed";
        }
      }
    }

    const canaryUnexpectedPass = doctorCanaryResult?.status === "unexpected_pass";
    if (
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      canaryUnexpectedPass &&
      successfulTasks.length > 0 &&
      !stopReason
    ) {
      const doctorStartedAt = Date.now();
      const doctorOutcome = await runDoctorValidatorWithReport({
        projectName,
        repoPath,
        runId,
        mainBranch: config.main_branch,
        doctorCommand: config.doctor,
        doctorCanary: doctorCanaryResult,
        trigger: "doctor_canary_failed",
        triggerNotes: "Doctor exited successfully with ORCH_CANARY=1 (expected non-zero).",
        config: doctorValidatorConfig,
        orchestratorLog: orchLog,
        logger: doctorValidatorLog ?? undefined,
      });
      recordDoctorDuration(runMetrics, Date.now() - doctorStartedAt);

      doctorValidatorLastCount = completed.size + failed.size;

      if (doctorOutcome) {
        const relativeReport = relativeReportPath(projectName, runId, doctorOutcome.reportPath);
        for (const r of successfulTasks) {
          setValidatorResult(state, r.taskId, {
            validator: "doctor",
            status: doctorOutcome.status,
            mode: doctorValidatorMode,
            summary: doctorOutcome.summary ?? undefined,
            report_path: relativeReport,
            trigger: doctorOutcome.trigger,
          });

          if (shouldBlockValidator(doctorValidatorMode, doctorOutcome.status)) {
            markTaskNeedsHumanReview(state, r.taskId, {
              validator: "doctor",
              reason:
                doctorOutcome.summary && doctorOutcome.summary.length > 0
                  ? `Doctor validator blocked merge: ${doctorOutcome.summary}`
                  : "Doctor validator blocked merge (mode=block)",
              summary: doctorOutcome.summary ?? undefined,
              reportPath: relativeReport,
            });
            state.status = "failed";
            stopReason = "validator_blocked";
            logOrchestratorEvent(orchLog, "validator.block", {
              validator: "doctor",
              taskId: r.taskId,
              mode: doctorValidatorMode,
              status: doctorOutcome.status,
              trigger: doctorOutcome.trigger ?? "unknown",
            });
          }
        }
        await stateStore.save(state);
        refreshStatusSets();
      }
    }

    const failedTaskIds = params.batchTasks
      .map((t) => t.manifest.id)
      .filter((id) => {
        const status = state.tasks[id]?.status;
        return (
          status === "failed" ||
          status === "needs_human_review" ||
          status === "needs_rescope" ||
          status === "rescope_required"
        );
      });
    const pendingTaskIds = params.batchTasks
      .map((t) => t.manifest.id)
      .filter((id) => state.tasks[id]?.status === "pending");
    const batchStatus: "complete" | "failed" =
      failedTaskIds.length > 0 ||
      pendingTaskIds.length > 0 ||
      hadPendingResets ||
      stopReason
        ? "failed"
        : "complete";

    completeBatch(state, params.batchId, batchStatus, {
      mergeCommit: batchMergeCommit,
      integrationDoctorPassed,
    });
    await stateStore.save(state);

    const postMergeFinishedCount = completed.size + failed.size;
    const shouldRunDoctorValidatorSuspicious =
      doctorValidatorEnabled && doctorValidatorConfig && integrationDoctorPassed === false;

    if (
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      shouldRunDoctorValidatorSuspicious &&
      !stopReason
    ) {
      const doctorStartedAt = Date.now();
      const doctorOutcome = await runDoctorValidatorWithReport({
        projectName,
        repoPath,
        runId,
        mainBranch: config.main_branch,
        doctorCommand: config.doctor,
        doctorCanary: lastIntegrationDoctorCanary,
        trigger: "integration_doctor_failed",
        triggerNotes: `Integration doctor failed for batch ${params.batchId} (exit code ${lastIntegrationDoctorExitCode ?? -1})`,
        integrationDoctorOutput: lastIntegrationDoctorOutput,
        config: doctorValidatorConfig,
        orchestratorLog: orchLog,
        logger: doctorValidatorLog ?? undefined,
      });
      recordDoctorDuration(runMetrics, Date.now() - doctorStartedAt);

      doctorValidatorLastCount = postMergeFinishedCount;

      if (doctorOutcome) {
        const relativeReport = relativeReportPath(projectName, runId, doctorOutcome.reportPath);
        for (const r of successfulTasks) {
          setValidatorResult(state, r.taskId, {
            validator: "doctor",
            status: doctorOutcome.status,
            mode: doctorValidatorMode,
            summary: doctorOutcome.summary ?? undefined,
            report_path: relativeReport,
            trigger: doctorOutcome.trigger,
          });

          if (shouldBlockValidator(doctorValidatorMode, doctorOutcome.status)) {
            markTaskNeedsHumanReview(state, r.taskId, {
              validator: "doctor",
              reason:
                doctorOutcome.summary && doctorOutcome.summary.length > 0
                  ? `Doctor validator blocked merge: ${doctorOutcome.summary}`
                  : "Doctor validator blocked merge (mode=block)",
              summary: doctorOutcome.summary ?? undefined,
              reportPath: relativeReport,
            });
            logOrchestratorEvent(orchLog, "validator.block", {
              validator: "doctor",
              taskId: r.taskId,
              mode: doctorValidatorMode,
              status: doctorOutcome.status,
              trigger: doctorOutcome.trigger ?? "unknown",
            });
          }
        }
        await stateStore.save(state);
      }
    }

    logOrchestratorEvent(orchLog, "batch.complete", { batch_id: params.batchId });
    return stopReason;
  }

  let batchId = Math.max(0, ...state.batches.map((b) => b.batch_id));
  while (true) {
    const stopResult = await stopIfRequested();
    if (stopResult) return stopResult;

    const runningBatch = findRunningBatch();
    if (runningBatch) {
      const batchTasks = tasks.filter((t) => runningBatch.tasks.includes(t.manifest.id));
      if (batchTasks.length === 0) {
        state.status = "failed";
        await stateStore.save(state);
        logOrchestratorEvent(orchLog, "run.stop", { reason: "running_batch_missing_tasks" });
        break;
      }

      const runningTasks = batchTasks.filter(
        (t) => state.tasks[t.manifest.id]?.status === "running",
      );
      const results = await Promise.all(runningTasks.map((task) => resumeRunningTask(task)));
      const stopReason = await finalizeBatch({
        batchId: runningBatch.batch_id,
        batchTasks,
        results,
      });

      if (stopReason) {
        logOrchestratorEvent(orchLog, "run.stop", { reason: stopReason });
        break;
      }
      continue;
    }

    const pendingTasks = tasks.filter((t) => state.tasks[t.manifest.id]?.status === "pending");
    if (pendingTasks.length === 0) break;

    const ready = topologicalReady(pendingTasks, completed);
    if (ready.length === 0) {
      logOrchestratorEvent(orchLog, "run.deadlock", {
        message: "No dependency-satisfied tasks remaining. Check dependencies field.",
      });
      state.status = "failed";
      await stateStore.save(state);
      break;
    }

    batchId += 1;
    const { batch } = buildGreedyBatch(ready, maxParallel, lockResolver);

    const batchTaskIds = batch.tasks.map((t) => t.manifest.id);
    plannedBatches.push({ batchId, taskIds: batchTaskIds, locks: batch.locks });
    const startedAt = isoNow();
    startBatch(state, { batchId, taskIds: batchTaskIds, locks: batch.locks, now: startedAt });
    await stateStore.save(state);

    logOrchestratorEvent(orchLog, "batch.start", {
      batch_id: batchId,
      tasks: batchTaskIds,
      locks: batch.locks,
      lock_mode: lockMode,
    });

    if (opts.dryRun) {
      logOrchestratorEvent(orchLog, "batch.dry_run", { batch_id: batchId, tasks: batchTaskIds });
      // Mark all as skipped for dry-run
      for (const t of batch.tasks) {
        state.tasks[t.manifest.id].status = "skipped";
        state.tasks[t.manifest.id].completed_at = isoNow();
        completed.add(t.manifest.id);
      }
      state.batches[state.batches.length - 1].status = "complete";
      state.batches[state.batches.length - 1].completed_at = isoNow();
      await stateStore.save(state);
      continue;
    }

    // Launch tasks in parallel.
    const results: TaskRunResult[] = await Promise.all(
      batch.tasks.map(async (task) => {
        const taskId = task.manifest.id;
        const taskSlug = task.slug;
        const branchName = buildTaskBranchName(
          config.task_branch_prefix,
          taskId,
          task.manifest.name,
        );
        const defaultDoctorCommand = task.manifest.verify?.doctor ?? config.doctor;
        const policyResult = controlPlaneConfig.enabled
          ? computeTaskPolicyDecision({
              task,
              derivedScopeReports,
              componentResourcePrefix: controlPlaneConfig.componentResourcePrefix,
              blastContext,
              checksConfig: controlPlaneConfig.checks,
              defaultDoctorCommand,
              surfacePatterns: controlPlaneConfig.surfacePatterns,
              fallbackResource: controlPlaneConfig.fallbackResource,
            })
          : null;

        if (policyResult) {
          policyDecisions.set(taskId, policyResult.policyDecision);
          const policyReportPath = taskPolicyReportPath(repoPath, runId, taskId);
          try {
            await writeJsonFile(policyReportPath, policyResult.policyDecision);
          } catch (error) {
            logOrchestratorEvent(orchLog, "task.policy.error", {
              taskId,
              task_slug: taskSlug,
              message: formatErrorMessage(error),
            });
          }

          const reportPath = taskChecksetReportPath(repoPath, runId, taskId);
          try {
            await writeJsonFile(reportPath, policyResult.checksetReport);
          } catch (error) {
            logOrchestratorEvent(orchLog, "task.checkset.error", {
              taskId,
              task_slug: taskSlug,
              message: formatErrorMessage(error),
            });
          }
        }

        const doctorCommand = policyResult
          ? policyResult.doctorCommand
          : defaultDoctorCommand;

        const workspace = taskWorkspaceDir(projectName, runId, taskId);
        const tLogsDir = taskLogsDir(projectName, runId, taskId, taskSlug);
        const codexHome = workerCodexHomeDir(projectName, runId, taskId, taskSlug);
        const codexConfigPath = path.join(codexHome, "config.toml");
        const codexReasoningEffort = resolveCodexReasoningEffort(
          config.worker.model,
          config.worker.reasoning_effort,
        );
        const taskRelativeDir = path.relative(tasksRootAbs, task.taskDir);
        const taskRelativeDirPosix = taskRelativeDir.split(path.sep).join(path.posix.sep);

        await ensureDir(tLogsDir);

        logOrchestratorEvent(orchLog, "workspace.prepare.start", { taskId, workspace });
        const workspacePrep = await prepareTaskWorkspace({
          projectName,
          runId,
          taskId,
          repoPath,
          mainBranch: config.main_branch,
          taskBranch: branchName,
        });
        logOrchestratorEvent(orchLog, "workspace.prepare.complete", {
          taskId,
          workspace,
          created: workspacePrep.created,
        });

        await ensureDir(codexHome);
        await writeCodexConfig(codexConfigPath, {
          model: config.worker.model,
          modelReasoningEffort: codexReasoningEffort,
          // "never" means no approval prompts (unattended runs). See Codex config reference.
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        });
        // If the user authenticated via `codex login`, auth material typically lives under
        // ~/.codex/auth.json (file-based storage). Because we run each worker with a custom
        // CODEX_HOME, we copy that auth file into this per-task CODEX_HOME when no API key is provided.
        if (!mockLlmMode) {
          const auth = await ensureCodexAuthForHome(codexHome);
          logOrchestratorEvent(orchLog, "codex.auth", {
            taskId,
            mode: auth.mode,
            source: auth.mode === "env" ? auth.var : "auth.json",
          });
        } else {
          logOrchestratorEvent(orchLog, "codex.auth", {
            taskId,
            mode: "mock",
            source: "MOCK_LLM",
          });
        }

        // Ensure tasks directory is available inside the clone (copy from integration repo).
        const srcTasksDir = path.join(repoPath, config.tasks_dir);
        const destTasksDir = path.join(workspace, config.tasks_dir);
        await fse.remove(destTasksDir);
        await fse.copy(srcTasksDir, destTasksDir);

        await syncWorkerStateIntoTask(taskId, workspace);

        // Prepare per-task logger.
        const taskEvents = new JsonlLogger(
          taskEventsLogPath(projectName, runId, taskId, taskSlug),
          { runId, taskId },
        );

        state.tasks[taskId].branch = branchName;
        state.tasks[taskId].workspace = workspace;
        state.tasks[taskId].logs_dir = tLogsDir;
        await stateStore.save(state);

        if (useDocker && docker) {
          const containerName = `to-${projectName}-${runId}-${taskId}-${taskSlug}`
            .replace(/[^a-zA-Z0-9_.-]/g, "-")
            .slice(0, 120);
          const existing = await findContainerByName(docker, containerName);
          if (existing) {
            // If container name already exists (stale), remove it.
            await removeContainer(existing);
          }

          const codexHomeInContainer = path.posix.join("/workspace", ".mycelium", "codex-home");

          const container = await createContainer(docker, {
            name: containerName,
            image: workerImage,
            user: containerUser,
            env: {
              // Credentials / routing (passed through from the host).
              CODEX_API_KEY: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
              OPENAI_API_KEY: process.env.OPENAI_API_KEY,
              OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
              OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION,

              TASK_ID: taskId,
              TASK_SLUG: taskSlug,
              TASK_MANIFEST_PATH: path.posix.join(
                "/workspace",
                tasksDirPosix,
                taskRelativeDirPosix,
                "manifest.json",
              ),
              TASK_SPEC_PATH: path.posix.join(
                "/workspace",
                tasksDirPosix,
                taskRelativeDirPosix,
                "spec.md",
              ),
              TASK_BRANCH: branchName,
              DOCTOR_CMD: doctorCommand,
              DOCTOR_TIMEOUT: config.doctor_timeout ? String(config.doctor_timeout) : undefined,
              MAX_RETRIES: String(config.max_retries),
              CHECKPOINT_COMMITS: config.worker.checkpoint_commits ? "true" : "false",
              DEFAULT_TEST_PATHS: JSON.stringify(config.test_paths ?? []),
              BOOTSTRAP_CMDS:
                config.bootstrap.length > 0 ? JSON.stringify(config.bootstrap) : undefined,
              CODEX_MODEL: config.worker.model,
              CODEX_MODEL_REASONING_EFFORT: codexReasoningEffort,
              CODEX_HOME: codexHomeInContainer,
              RUN_LOGS_DIR: "/run-logs",
              LOG_CODEX_PROMPTS: config.worker.log_codex_prompts ? "1" : "0",
            },
            binds: [
              { hostPath: workspace, containerPath: "/workspace", mode: "rw" },
              { hostPath: tLogsDir, containerPath: "/run-logs", mode: "rw" },
            ],
            workdir: "/workspace",
            networkMode,
            resources: containerResources,
            labels: buildContainerLabels({
              projectName,
              runId,
              taskId,
              branchName,
              workspace,
            }),
          });

          const containerInfo = await container.inspect();
          const containerId = containerInfo.Id;
          state.tasks[taskId].container_id = containerId;
          await stateStore.save(state);

          logOrchestratorEvent(orchLog, "container.create", {
            taskId,
            container_id: containerId,
            name: containerName,
            security: containerSecurityPayload,
          });

          // Attach log stream
          const logStream = await streamContainerLogs(container, taskEvents, {
            fallbackType: "task.log",
          });

          try {
            await startContainer(container);
            logOrchestratorEvent(orchLog, "container.start", { taskId, container_id: containerId });

            if (crashAfterContainerStart) {
              // Simulate an orchestrator crash for resume drills; the worker container keeps running.
              process.kill(process.pid, "SIGKILL");
            }

            const waited = await waitContainer(container);

            logOrchestratorEvent(orchLog, "container.exit", {
              taskId,
              container_id: containerId,
              exit_code: waited.exitCode,
            });

            if (cleanupOnSuccess && waited.exitCode === 0) {
              await removeContainer(container);
            }

            await syncWorkerStateIntoTask(taskId, workspace);

            if (waited.exitCode === 0) {
              return {
                taskId,
                taskSlug,
                branchName,
                workspace,
                logsDir: tLogsDir,
                success: true as const,
              };
            }

            return {
              taskId,
              taskSlug,
              branchName,
              workspace,
              logsDir: tLogsDir,
              errorMessage: `Task worker container exited with code ${waited.exitCode}`,
              success: false as const,
            };
          } finally {
            logStream.detach();
            await logStream.completed.catch(() => undefined);
            taskEvents.close();
          }
        }

        logOrchestratorEvent(orchLog, "worker.local.start", { taskId, workspace });
        const manifestPath = path.join(
          workspace,
          config.tasks_dir,
          taskRelativeDir,
          "manifest.json",
        );
        const specPath = path.join(workspace, config.tasks_dir, taskRelativeDir, "spec.md");
        const workerLogger = createLocalWorkerLogger(taskEvents, { taskId, taskSlug });

        const previousLogCodexPrompts = process.env.LOG_CODEX_PROMPTS;
        process.env.LOG_CODEX_PROMPTS = config.worker.log_codex_prompts ? "1" : "0";

        try {
          await runWorker(
            {
              taskId,
              taskSlug,
              taskBranch: branchName,
              manifestPath,
              specPath,
              doctorCmd: doctorCommand,
              doctorTimeoutSeconds: config.doctor_timeout,
              maxRetries: config.max_retries,
              bootstrapCmds: config.bootstrap,
              runLogsDir: tLogsDir,
              codexHome,
              codexModel: config.worker.model,
              checkpointCommits: config.worker.checkpoint_commits,
              workingDirectory: workspace,
              defaultTestPaths: config.test_paths,
            },
            workerLogger,
          );
          logOrchestratorEvent(orchLog, "worker.local.complete", { taskId });
          await syncWorkerStateIntoTask(taskId, workspace);
          return {
            taskId,
            taskSlug,
            branchName,
            workspace,
            logsDir: tLogsDir,
            success: true as const,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logOrchestratorEvent(orchLog, "worker.local.error", { taskId, message });
          await syncWorkerStateIntoTask(taskId, workspace);
          return {
            taskId,
            taskSlug,
            branchName,
            workspace,
            logsDir: tLogsDir,
            errorMessage: message,
            success: false as const,
          };
        } finally {
          if (previousLogCodexPrompts === undefined) {
            delete process.env.LOG_CODEX_PROMPTS;
          } else {
            process.env.LOG_CODEX_PROMPTS = previousLogCodexPrompts;
          }
          taskEvents.close();
        }
      }),
    );

    const stopReason = await finalizeBatch({ batchId, batchTasks: batch.tasks, results });

    if (stopReason) {
      logOrchestratorEvent(orchLog, "run.stop", { reason: stopReason });
      break;
    }
  }

  const stopAfterLoop = await stopIfRequested();
  if (stopAfterLoop) return stopAfterLoop;

  if (state.status === "running") {
    state.status = failed.size > 0 ? "failed" : "complete";
  }
  await stateStore.save(state);

  const runSummary = buildRunSummary({
    runId,
    projectName,
    state,
    lockMode,
    scopeMode: scopeComplianceMode,
    controlPlaneEnabled: controlPlaneConfig.enabled,
    metrics: runMetrics,
  });
  const runSummaryPath = runSummaryReportPath(repoPath, runId);
  try {
    await writeJsonFile(runSummaryPath, runSummary);
    logOrchestratorEvent(orchLog, "run.summary", {
      status: state.status,
      report_path: runSummaryPath,
      metrics: runSummary.metrics,
    });
  } catch (error) {
    logOrchestratorEvent(orchLog, "run.summary.error", {
      status: state.status,
      report_path: runSummaryPath,
      message: formatErrorMessage(error),
    });
  }

  logOrchestratorEvent(orchLog, "run.complete", { status: state.status });
  closeValidatorLogs();
  orchLog.close();

  // Optional cleanup of successful workspaces can be added later.
  return { runId, state, plan: plannedBatches };
  } finally {
    stopController.cleanup();
  }
}

async function summarizeTestValidatorResult(
  reportPath: string,
  result: TestValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<TestValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeTestReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Test validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

async function runDoctorValidatorWithReport(args: {
  projectName: string;
  repoPath: string;
  runId: string;
  mainBranch: string;
  doctorCommand: string;
  doctorCanary?: DoctorCanaryResult;
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  config: DoctorValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
}): Promise<ValidatorRunSummary | null> {
  const reportDir = path.join(validatorsLogsDir(args.projectName, args.runId), "doctor-validator");
  const before = await listValidatorReports(reportDir);

  let doctorResult: DoctorValidationReport | null = null;
  let error: string | null = null;
  try {
    doctorResult = await runDoctorValidator({
      projectName: args.projectName,
      repoPath: args.repoPath,
      runId: args.runId,
      mainBranch: args.mainBranch,
      doctorCommand: args.doctorCommand,
      doctorCanary: args.doctorCanary,
      trigger: args.trigger,
      triggerNotes: args.triggerNotes,
      integrationDoctorOutput: args.integrationDoctorOutput,
      config: args.config,
      orchestratorLog: args.orchestratorLog,
      logger: args.logger,
    });
  } catch (err) {
    error = formatErrorMessage(err);
  }

  const reportPath = await findLatestReport(reportDir, before);
  if (doctorResult) {
    const status: ValidatorStatus =
      args.doctorCanary?.status === "unexpected_pass"
        ? "fail"
        : doctorResult.effective
          ? "pass"
          : "fail";
    return {
      status,
      summary: summarizeDoctorReport(doctorResult, args.doctorCanary),
      reportPath,
      trigger: args.trigger,
    };
  }

  if (error === null && args.config.enabled === false) {
    return null;
  }

  return {
    status: "error",
    summary: error ?? "Doctor validator returned no result (see validator log).",
    reportPath,
    trigger: args.trigger,
  };
}

function setValidatorResult(state: RunState, taskId: string, result: ValidatorResult): void {
  const task = state.tasks[taskId];
  if (!task) return;

  const existing = (task.validator_results ?? []).filter((r) => r.validator !== result.validator);
  task.validator_results = [...existing, result];
}

function relativeReportPath(
  projectName: string,
  runId: string,
  reportPath: string | null,
): string | undefined {
  if (!reportPath) return undefined;

  const base = runLogsDir(projectName, runId);
  const relative = path.relative(base, reportPath);
  return relative.startsWith("..") ? reportPath : relative;
}

function shouldBlockValidator(mode: ValidatorMode, status: ValidatorStatus): boolean {
  if (mode !== "block") return false;
  return status === "fail" || status === "error";
}

function resolveValidatorMode(cfg?: { enabled?: boolean; mode?: ValidatorMode }): ValidatorMode {
  if (!cfg) return "off";
  if (cfg.enabled === false) return "off";
  return cfg.mode ?? "warn";
}

async function readValidatorReport<T>(reportPath: string): Promise<T | null> {
  const exists = await fse.pathExists(reportPath);
  if (!exists) return null;

  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const payload = (raw as { result?: unknown }).result;
  if (!payload || typeof payload !== "object") return null;

  return payload as T;
}

async function listValidatorReports(reportDir: string): Promise<string[]> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return [];

  const entries = await fse.readdir(reportDir);
  return entries.filter((name) => name.toLowerCase().endsWith(".json"));
}

async function findLatestReport(reportDir: string, before: string[]): Promise<string | null> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return null;

  const entries = (await fse.readdir(reportDir)).filter((name) => name.toLowerCase().endsWith(".json"));
  if (entries.length === 0) return null;

  const candidates = await Promise.all(
    entries.map(async (name) => {
      const fullPath = path.join(reportDir, name);
      const stat = await fse.stat(fullPath).catch(() => null);
      return { name, fullPath, mtimeMs: stat?.mtimeMs ?? 0, isNew: !before.includes(name) };
    }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates.find((c) => c.isNew) ?? candidates[0];
  return newest?.fullPath ?? null;
}

const DOCTOR_CANARY_OUTPUT_LIMIT = 4_000;

async function runDoctorCanary(args: {
  command: string;
  cwd: string;
  timeoutSeconds?: number;
}): Promise<DoctorCanaryResult> {
  const res = await execaCommand(args.command, {
    cwd: args.cwd,
    shell: true,
    reject: false,
    env: { ...process.env, ORCH_CANARY: "1" },
    timeout: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
  });

  const exitCode = res.exitCode ?? -1;
  const output = limitText(`${res.stdout}\n${res.stderr}`.trim(), DOCTOR_CANARY_OUTPUT_LIMIT);

  if (exitCode === 0) {
    return { status: "unexpected_pass", exitCode, output };
  }

  return { status: "expected_fail", exitCode, output };
}

function summarizeTestReport(report: TestValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.coverage_gaps.length > 0) {
    parts.push(`Coverage gaps: ${report.coverage_gaps.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

function summarizeDoctorReport(
  report: DoctorValidationReport,
  canary?: DoctorCanaryResult,
): string {
  const parts = [
    `Effective: ${report.effective ? "yes" : "no"}`,
    `Coverage: ${report.coverage_assessment}`,
  ];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.recommendations.length > 0) {
    parts.push(`Recs: ${report.recommendations.length}`);
  }
  if (canary) {
    parts.push(formatDoctorCanarySummary(canary));
  }
  return parts.join(" | ");
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatDoctorCanarySummary(canary: DoctorCanaryResult): string {
  if (canary.status === "skipped") {
    return `Canary: skipped (${canary.reason})`;
  }

  return canary.status === "unexpected_pass"
    ? "Canary: unexpected pass with ORCH_CANARY=1"
    : "Canary: failed as expected with ORCH_CANARY=1";
}

function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated]`;
}

function buildStopController(signal?: AbortSignal): StopController {
  let reason: StopRequest | null = null;

  const onAbort = (): void => {
    if (reason) return;
    reason = { kind: "signal", signal: normalizeAbortReason(signal?.reason) };
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
    }
  }

  return {
    get reason() {
      return reason;
    },
    cleanup() {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function normalizeAbortReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;

  if (typeof reason === "object") {
    const value = reason as Record<string, unknown>;
    if (typeof value.signal === "string") return value.signal;
    if (typeof value.type === "string") return value.type;
  }

  return String(reason);
}

function buildStatusSets(state: RunState): { completed: Set<string>; failed: Set<string> } {
  const completed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => s.status === "complete" || s.status === "skipped")
      .map(([id]) => id),
  );
  const failed = new Set<string>(
    Object.entries(state.tasks)
      .filter(
        ([, s]) =>
          s.status === "failed" ||
          s.status === "needs_rescope" ||
          s.status === "rescope_required" ||
          s.status === "needs_human_review",
      )
      .map(([id]) => id),
  );
  return { completed, failed };
}

export function mergeCheckpointCommits(
  existing: CheckpointCommit[],
  incoming: WorkerCheckpoint[],
): CheckpointCommit[] {
  const byAttempt = new Map<number, CheckpointCommit>();

  for (const entry of existing) {
    byAttempt.set(entry.attempt, { ...entry });
  }
  for (const entry of incoming) {
    byAttempt.set(entry.attempt, {
      attempt: entry.attempt,
      sha: entry.sha,
      created_at: entry.created_at,
    });
  }

  return Array.from(byAttempt.values()).sort((a, b) => a.attempt - b.attempt);
}

export function checkpointListsEqual(a: CheckpointCommit[], b: CheckpointCommit[]): boolean {
  if (a.length !== b.length) return false;

  return a.every(
    (entry, idx) =>
      entry.attempt === b[idx].attempt &&
      entry.sha === b[idx].sha &&
      entry.created_at === b[idx].created_at,
  );
}

function firstContainerName(names?: string[]): string | undefined {
  if (!names || names.length === 0) return undefined;
  const raw = names[0] ?? "";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

function createLocalWorkerLogger(
  taskEvents: JsonlLogger,
  defaults: { taskId: string; taskSlug: string },
): WorkerLogger {
  return {
    log(event: WorkerLogEventInput) {
      const normalized = normalizeWorkerEvent(event, defaults);
      logJsonLineOrRaw(taskEvents, JSON.stringify(normalized), "stdout", "task.log");
    },
  };
}

function normalizeWorkerEvent(
  event: WorkerLogEventInput,
  defaults: { taskId: string; taskSlug: string },
): Record<string, unknown> {
  const ts =
    typeof event.ts === "string"
      ? event.ts
      : event.ts instanceof Date
        ? event.ts.toISOString()
        : isoNow();

  const payload =
    event.payload && Object.keys(event.payload).length > 0 ? event.payload : undefined;

  const normalized: Record<string, unknown> = {
    ts,
    type: event.type,
  };

  if (event.attempt !== undefined) normalized.attempt = event.attempt;

  const taskId = event.taskId ?? defaults.taskId;
  if (taskId) normalized.task_id = taskId;

  const taskSlug = event.taskSlug ?? defaults.taskSlug;
  if (taskSlug) normalized.task_slug = taskSlug;

  if (payload) normalized.payload = payload;

  return normalized;
}

async function writeCodexConfig(
  filePath: string,
  opts: {
    model: string;
    modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    // Valid values per Codex config reference.
    approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  },
): Promise<void> {
  // Codex config format uses root keys in config.toml.
  // See upstream examples and config reference.
  // We keep it intentionally minimal here.
  const content = [
    `model = "${opts.model}"`,
    ...(opts.modelReasoningEffort
      ? [`model_reasoning_effort = "${opts.modelReasoningEffort}"`]
      : []),
    `approval_policy = "${opts.approvalPolicy}"`,
    `sandbox_mode = "${opts.sandboxMode}"`,
    "",
  ].join("\n");
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
