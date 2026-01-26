import path from "node:path";

import { execa, execaCommand } from "execa";
import fg from "fast-glob";
import fse from "fs-extra";

import {
  buildRunContext,
  buildRunContextBase,
} from "../app/orchestrator/run-context-builder.js";
import type { ControlPlaneRunConfig } from "../app/orchestrator/run-context.js";
import { runEngine } from "../app/orchestrator/run-engine.js";
import { formatErrorMessage, normalizeAbortReason } from "../app/orchestrator/helpers/errors.js";
import { DockerWorkerRunner } from "../app/orchestrator/workers/docker-worker-runner.js";
import { LocalWorkerRunner } from "../app/orchestrator/workers/local-worker-runner.js";
import type { WorkerRunner, WorkerRunnerResult } from "../app/orchestrator/workers/worker-runner.js";
import {
  buildDoctorCanarySummary,
  formatDoctorCanaryEnvVar,
  limitText,
  summarizeArchitectureReport,
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "../app/orchestrator/helpers/format.js";
import { averageRounded, secondsFromMs } from "../app/orchestrator/helpers/time.js";
import type { ContainerSpec } from "../docker/docker.js";
import { ensureCleanWorkingTree, checkout, resolveRunBaseSha, headSha, isAncestor } from "../git/git.js";
import { mergeTaskBranches } from "../git/merge.js";
import { buildTaskBranchName } from "../git/branches.js";
import { listChangedFiles } from "../git/changes.js";
import { ensureCodexAuthForHome } from "./codexAuth.js";
import { resolveCodexReasoningEffort } from "./codex-reasoning.js";

import type {
  ControlPlaneLockMode,
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
  DoctorValidatorConfig,
  ManifestEnforcementPolicy,
  ProjectConfig,
  ResourceConfig,
  ValidatorMode,
} from "./config.js";
import { detectBudgetBreaches, parseTaskTokenUsage, recomputeRunUsage, type TaskUsageUpdate } from "./budgets.js";
import {
  JsonlLogger,
  logOrchestratorEvent,
  logRunResume,
  logTaskReset,
  type JsonObject,
} from "./logger.js";
import { loadTaskSpecs } from "./task-loader.js";
import { normalizeLocks, type TaskSpec } from "./task-manifest.js";
import {
  moveTaskDir,
  resolveTaskDir,
  resolveTaskManifestPath,
  resolveTaskSpecPath,
  resolveTasksArchiveDir,
} from "./task-layout.js";
import {
  computeTaskFingerprint,
  importLedgerFromRunState,
  loadTaskLedger,
  upsertLedgerEntry,
  type TaskLedger,
  type TaskLedgerEntry,
} from "./task-ledger.js";
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
import { StateStore } from "./state-store.js";
import {
  completeBatch,
  createRunState,
  markTaskNeedsHumanReview,
  markTaskComplete,
  markTaskValidated,
  markTaskFailed,
  markTaskRescopeRequired,
  resetTaskToPending,
  startBatch,
  type CheckpointCommit,
  type ControlPlaneSnapshot,
  type RunState,
  type TaskStatus,
  type ValidatorResult,
  type ValidatorStatus,
} from "./state.js";
import { ensureDir, isoNow, readJsonFile, writeJsonFile } from "./utils.js";
import { prepareTaskWorkspace, removeTaskWorkspace } from "./workspaces.js";
import {
  runDoctorValidator,
  type DoctorValidationReport,
  type DoctorCanaryResult,
  type DoctorValidatorTrigger,
} from "../validators/doctor-validator.js";
import { runTestValidator, type TestValidationReport } from "../validators/test-validator.js";
import { runStyleValidator, type StyleValidationReport } from "../validators/style-validator.js";
import {
  runArchitectureValidator,
  type ArchitectureValidationReport,
} from "../validators/architecture-validator.js";
import { loadWorkerState, type WorkerCheckpoint } from "../../worker/state.js";
import {
  runManifestCompliance,
  type ManifestComplianceResult,
  type ResourceOwnershipResolver,
} from "./manifest-compliance.js";
import { computeRescopeFromCompliance } from "./manifest-rescope.js";
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
import type { PolicyDecision, SurfacePatternSet } from "../control-plane/policy/types.js";
import { type ChecksetDecision } from "../control-plane/policy/checkset.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
} from "../control-plane/policy/eval.js";

export type RunOptions = {
  runId?: string;
  resume?: boolean;
  reuseCompleted?: boolean;
  importRun?: string;
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
  const fallbackResource = input.controlPlaneConfig.fallbackResource;
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

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<RunResult> {
  const context = await buildRunContext({
    projectName,
    config,
    options: opts,
    legacy: { runProject: runProjectLegacy },
  });

  return runEngine(context);
}

// Legacy run flow remains intact while orchestration is extracted.
async function runProjectLegacy(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<RunResult> {
  const stopController = buildStopController(opts.stopSignal);

  try {
    const runContext = await buildRunContextBase({
      projectName,
      config,
      options: opts,
    });
    const {
      run: { runId, isResume, reuseCompleted, importRunId, maxParallel },
      cleanup: {
        workspacesOnSuccess: cleanupWorkspacesOnSuccess,
        containersOnSuccess: cleanupContainersOnSuccess,
      },
      paths: { repoPath, tasksRootAbs, tasksDirPosix },
      docker: {
        useDocker,
        stopContainersOnExit,
        workerImage,
        containerResources,
        containerSecurityPayload,
        networkMode,
        containerUser,
      },
      policy: { manifestPolicy, costPer1kTokens, mockLlmMode },
      flags: { crashAfterContainerStart },
      validators: {
        test: {
          config: testValidatorConfig,
          mode: testValidatorMode,
          enabled: testValidatorEnabled,
        },
        style: {
          config: styleValidatorConfig,
          mode: styleValidatorMode,
          enabled: styleValidatorEnabled,
        },
        architecture: {
          config: architectureValidatorConfig,
          mode: architectureValidatorMode,
          enabled: architectureValidatorEnabled,
        },
        doctor: {
          config: doctorValidatorConfig,
          mode: doctorValidatorMode,
          enabled: doctorValidatorEnabled,
        },
        doctorCanary: doctorCanaryConfig,
      },
    } = runContext.resolved;
    let controlPlaneConfig = runContext.resolved.controlPlane.config;
    const plannedBatches: BatchPlanEntry[] = [];
    const workerRunner = createWorkerRunner({
      useDocker,
      projectName,
      runId,
      config,
      tasksDirPosix,
      workerImage,
      containerResources,
      containerSecurityPayload,
      networkMode,
      containerUser,
    });
    let stopRequested: StopRequest | null = null;
    let state!: RunState;

    // Prepare directories
    await ensureDir(orchestratorHome());
    const stateStore = new StateStore(projectName, runId);
    const orchLog = new JsonlLogger(orchestratorLogPath(projectName, runId), { runId });
    let testValidatorLog: JsonlLogger | null = null;
    let styleValidatorLog: JsonlLogger | null = null;
    let architectureValidatorLog: JsonlLogger | null = null;
    let doctorValidatorLog: JsonlLogger | null = null;
    const closeValidatorLogs = (): void => {
      if (testValidatorLog) {
        testValidatorLog.close();
      }
      if (styleValidatorLog) {
        styleValidatorLog.close();
      }
      if (architectureValidatorLog) {
        architectureValidatorLog.close();
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

    const canResume =
      state.status === "running" || (isResume && state.status === "paused");
    if (!canResume) {
      logRunResume(orchLog, { status: state.status, reason: runResumeReason });
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_not_running" });
      closeValidatorLogs();
      orchLog.close();
      return { runId, state, plan: plannedBatches };
    }

    if (state.status === "paused" && isResume) {
      state.status = "running";
      await stateStore.save(state);
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

  const lockMode = resolveEffectiveLockMode(controlPlaneConfig);
  const scopeComplianceMode = resolveScopeComplianceMode(controlPlaneConfig);
  const shouldEnforceCompliance = scopeComplianceMode === "enforce";
  const compliancePolicy = scopeComplianceMode === "off" ? "off" : manifestPolicy;

  const resourceContext = await buildResourceResolutionContext({
    repoPath,
    controlPlaneConfig,
    controlPlaneSnapshot,
    staticResources: config.resources,
  });

  // Load tasks.
  let tasks: TaskSpec[];
  let taskCatalog: TaskSpec[];
  try {
    const res = await loadTaskSpecs(repoPath, config.tasks_dir, {
      knownResources: resourceContext.knownResources,
    });
    tasks = res.tasks;
    taskCatalog = res.tasks;
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
  if (styleValidatorEnabled) {
    styleValidatorLog = new JsonlLogger(validatorLogPath(projectName, runId, "style-validator"), {
      runId,
    });
  }
  if (architectureValidatorEnabled) {
    architectureValidatorLog = new JsonlLogger(
      validatorLogPath(projectName, runId, "architecture-validator"),
      { runId },
    );
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

  // Ensure worker runtime is ready (no-op for local runs).
  const shouldBuildImage = opts.buildImage ?? true;
  await workerRunner.prepare({
    buildImage: shouldBuildImage,
    orchestratorLogger: orchLog,
  });

  const refreshTaskUsage = (taskId: string, taskSlug: string): TaskUsageUpdate | null => {
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
  };

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

  const ledgerEligibilityCache = new Map<string, LedgerEligibilityResult>();
  const ledgerReachabilityCache = new Map<string, boolean>();
  const ledgerFingerprintCache = new Map<string, string>();
  let ledgerLoaded = false;
  let ledgerSnapshot: TaskLedger | null = null;
  let ledgerHeadSha: string | null = null;
  let taskFileIndex: Map<string, TaskFileLocation> | null = null;

  const ensureLedgerContext = async (): Promise<LedgerContext> => {
    if (!ledgerLoaded) {
      ledgerSnapshot = await loadTaskLedger(projectName);
      ledgerLoaded = true;
    }
    if (!ledgerHeadSha) {
      ledgerHeadSha = await headSha(repoPath);
    }
    if (!taskFileIndex) {
      taskFileIndex = await buildTaskFileIndex({
        tasksRoot: tasksRootAbs,
        tasks: taskCatalog,
      });
    }

    return {
      ledger: ledgerSnapshot,
      headSha: ledgerHeadSha,
      taskFileIndex,
    };
  };

  if (importRunId) {
    logOrchestratorEvent(orchLog, "ledger.import.start", { run_id: importRunId });
    const importStore = new StateStore(projectName, importRunId);
    if (!(await importStore.exists())) {
      logOrchestratorEvent(orchLog, "ledger.import.error", {
        run_id: importRunId,
        message: "Run state not found for import.",
      });
      throw new Error(`Cannot import run ${importRunId}: state file not found.`);
    }

    const importState = await importStore.load();
    const importResult = await importLedgerFromRunState({
      projectName,
      repoPath,
      tasksRoot: path.resolve(repoPath, config.tasks_dir),
      runId: importRunId,
      tasks: taskCatalog,
      state: importState,
    });
    logOrchestratorEvent(orchLog, "ledger.import.complete", {
      run_id: importRunId,
      imported: importResult.imported,
      skipped: importResult.skipped,
    });
  }

  const shouldSeedFromLedger = reuseCompleted && (!hadExistingState || isResume);
  if (shouldSeedFromLedger) {
    const ledgerContext = await ensureLedgerContext();
    const seedResult = await seedRunFromLedger({
      tasks,
      state,
      ledger: ledgerContext.ledger,
      repoPath,
      headSha: ledgerContext.headSha,
      taskFileIndex: ledgerContext.taskFileIndex,
      eligibilityCache: ledgerEligibilityCache,
      reachabilityCache: ledgerReachabilityCache,
      fingerprintCache: ledgerFingerprintCache,
    });

    for (const seeded of seedResult.seeded) {
      logOrchestratorEvent(orchLog, "task.seeded_complete", {
        task_id: seeded.taskId,
        merge_commit: seeded.entry.mergeCommit ?? null,
        ledger_run_id: seeded.entry.runId ?? null,
      });
    }

    if (seedResult.seeded.length > 0) {
      await stateStore.save(state);
    }
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

  const stopRun = async (reason: StopRequest): Promise<RunResult> => {
    const stopSummary = await workerRunner.stop({
      stopContainersOnExit,
      orchestratorLogger: orchLog,
    });
    const containerAction: RunStopInfo["containers"] = stopSummary ? "stopped" : "left_running";
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
  };

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

  const ensureTaskActiveStage = async (task: TaskSpec): Promise<void> => {
    if (task.stage !== "backlog") {
      return;
    }

    const moveResult = await moveTaskDir({
      tasksRoot: tasksRootAbs,
      fromStage: "backlog",
      toStage: "active",
      taskDirName: task.taskDirName,
    });

    task.stage = "active";

    if (moveResult.moved) {
      logOrchestratorEvent(orchLog, "task.stage.move", {
        taskId: task.manifest.id,
        from: "backlog",
        to: "active",
        path_from: moveResult.fromPath,
        path_to: moveResult.toPath,
      });
    }
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

  const buildReadyForValidationSummaries = (batchTasks: TaskSpec[]): TaskSuccessResult[] => {
    const summaries: TaskSuccessResult[] = [];
    for (const task of batchTasks) {
      const taskState = state.tasks[task.manifest.id];
      if (!taskState || taskState.status !== "running") continue;

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

  const buildValidatedTaskSummaries = (batchTasks: TaskSpec[]): TaskSuccessResult[] => {
    const summaries: TaskSuccessResult[] = [];
    for (const task of batchTasks) {
      const taskState = state.tasks[task.manifest.id];
      if (!taskState || taskState.status !== "validated") continue;

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

  const cleanupSuccessfulBatchArtifacts = async (args: {
    batchStatus: "complete" | "failed";
    integrationDoctorPassed?: boolean;
    successfulTasks: TaskSuccessResult[];
  }): Promise<void> => {
    if (!cleanupWorkspacesOnSuccess && !cleanupContainersOnSuccess) return;
    if (args.batchStatus !== "complete") return;
    if (args.integrationDoctorPassed !== true) return;
    if (args.successfulTasks.length === 0) return;

    // Skip cleanup when a stop signal is pending so resuming keeps the workspace state.
    if (stopRequested !== null || stopController.reason !== null) return;

    if (cleanupContainersOnSuccess) {
      for (const task of args.successfulTasks) {
        await workerRunner.cleanupTask({
          taskId: task.taskId,
          containerIdHint: state.tasks[task.taskId]?.container_id,
          orchestratorLogger: orchLog,
        });
      }
    }

    if (cleanupWorkspacesOnSuccess) {
      for (const task of args.successfulTasks) {
        try {
          await removeTaskWorkspace(projectName, runId, task.taskId);
          logOrchestratorEvent(orchLog, "workspace.cleanup", {
            taskId: task.taskId,
            workspace: task.workspace,
          });
        } catch (error) {
          logOrchestratorEvent(orchLog, "workspace.cleanup.error", {
            taskId: task.taskId,
            workspace: task.workspace,
            message: formatErrorMessage(error),
          });
        }
      }
    }
  };

  const resumeRunningTask = async (task: TaskSpec): Promise<TaskRunResult> => {
    const taskId = task.manifest.id;
    const taskState = state.tasks[taskId];
    const meta = resolveTaskMeta(task);

    await ensureTaskActiveStage(task);
    await syncWorkerStateIntoTask(taskId, meta.workspace);
    const taskEventsPath = taskEventsLogPath(projectName, runId, taskId, task.slug);
    await ensureDir(path.dirname(taskEventsPath));
    const taskEvents = new JsonlLogger(taskEventsPath, { runId, taskId });

    let resumeResult: WorkerRunnerResult;
    try {
      resumeResult = await workerRunner.resumeAttempt({
        taskId,
        taskSlug: task.slug,
        workspace: meta.workspace,
        containerIdHint: taskState?.container_id,
        taskEvents,
        orchestratorLogger: orchLog,
      });
    } finally {
      taskEvents.close();
    }

    if (resumeResult.containerId) {
      taskState.container_id = resumeResult.containerId;
    }

    await syncWorkerStateIntoTask(taskId, meta.workspace);

    if (resumeResult.resetToPending) {
      const reason = resumeResult.errorMessage ?? "Task reset to pending";
      logTaskReset(orchLog, taskId, reason);
      return {
        success: false,
        taskId,
        taskSlug: task.slug,
        branchName: meta.branchName,
        workspace: meta.workspace,
        logsDir: meta.logsDir,
        errorMessage: resumeResult.errorMessage,
        resetToPending: true,
      };
    }

    if (resumeResult.success) {
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
      errorMessage: resumeResult.errorMessage,
    };
  };

  const logComplianceEvents = (args: {
    taskId: string;
    taskSlug: string;
    policy: ManifestEnforcementPolicy;
    scopeMode: ControlPlaneScopeMode;
    reportPath: string;
    result: ManifestComplianceResult;
  }): void => {
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
  };

  const describeManifestViolations = (result: ManifestComplianceResult): string => {
    const count = result.violations.length;
    const example = result.violations[0]?.path;
    const detail = example ? ` (example: ${example})` : "";
    return `${count} undeclared access request(s)${detail}`;
  };

  const finalizeBatch = async (params: {
    batchId: number;
    batchTasks: TaskSpec[];
    results: TaskRunResult[];
  }): Promise<
    | "merge_conflict"
    | "integration_doctor_failed"
    | "budget_block"
    | undefined
  > => {
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
          const manifestPath = resolveTaskManifestPath({
            tasksRoot: tasksRootAbs,
            stage: taskSpec.stage,
            taskDirName: taskSpec.taskDirName,
          });
          await writeJsonFile(manifestPath, rescope.manifest);
          taskSpec.manifest = rescope.manifest;

          const resetReason = `Rescoped manifest: +${rescope.addedLocks.length} locks, +${rescope.addedFiles.length} files`;
          resetTaskToPending(state, r.taskId, resetReason);
          logOrchestratorEvent(orchLog, "task.rescope.updated", {
            taskId: r.taskId,
            added_locks: rescope.addedLocks,
            added_files: rescope.addedFiles,
            manifest_path: manifestPath,
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
        continue;
      }

    }

    await stateStore.save(state);
    refreshStatusSets();

    const readyForValidation = buildReadyForValidationSummaries(params.batchTasks);
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
            tasksRoot: tasksRootAbs,
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

    if (styleValidatorEnabled && styleValidatorConfig) {
      for (const r of readyForValidation) {
        const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);
        if (!taskSpec) continue;

        const reportPath = validatorReportPath(
          projectName,
          runId,
          "style-validator",
          r.taskId,
          r.taskSlug,
        );

        let styleResult: StyleValidationReport | null = null;
        let styleError: string | null = null;
        const styleStartedAt = Date.now();
        try {
          styleResult = await runStyleValidator({
            projectName,
            repoPath,
            runId,
            tasksRoot: tasksRootAbs,
            task: taskSpec,
            taskSlug: r.taskSlug,
            workspacePath: r.workspace,
            mainBranch: config.main_branch,
            config: styleValidatorConfig,
            orchestratorLog: orchLog,
            logger: styleValidatorLog ?? undefined,
          });
        } catch (err) {
          styleError = err instanceof Error ? err.message : String(err);
          logOrchestratorEvent(orchLog, "validator.error", {
            validator: "style",
            taskId: r.taskId,
            message: styleError,
          });
        } finally {
          recordChecksetDuration(runMetrics, Date.now() - styleStartedAt);
        }

        const outcome = await summarizeStyleValidatorResult(reportPath, styleResult, styleError);
        const relativeReport = relativeReportPath(projectName, runId, outcome.reportPath);

        setValidatorResult(state, r.taskId, {
          validator: "style",
          status: outcome.status,
          mode: styleValidatorMode,
          summary: outcome.summary ?? undefined,
          report_path: relativeReport,
        });

        if (shouldBlockValidator(styleValidatorMode, outcome.status)) {
          blockedTasks.add(r.taskId);
          const reason =
            outcome.summary !== null && outcome.summary.trim().length > 0
              ? `Style validator blocked merge: ${outcome.summary}`
              : "Style validator blocked merge (mode=block)";
          markTaskNeedsHumanReview(state, r.taskId, {
            validator: "style",
            reason,
            summary: outcome.summary ?? undefined,
            reportPath: relativeReport,
          });
          logOrchestratorEvent(orchLog, "validator.block", {
            validator: "style",
            taskId: r.taskId,
            mode: styleValidatorMode,
            status: outcome.status,
          });
        }
      }
    }

    if (architectureValidatorEnabled && architectureValidatorConfig) {
      for (const r of readyForValidation) {
        const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);
        if (!taskSpec) continue;

        const reportPath = validatorReportPath(
          projectName,
          runId,
          "architecture-validator",
          r.taskId,
          r.taskSlug,
        );

        let architectureResult: ArchitectureValidationReport | null = null;
        let architectureError: string | null = null;
        const architectureStartedAt = Date.now();
        try {
          architectureResult = await runArchitectureValidator({
            projectName,
            repoPath,
            runId,
            tasksRoot: tasksRootAbs,
            task: taskSpec,
            taskSlug: r.taskSlug,
            workspacePath: r.workspace,
            mainBranch: config.main_branch,
            config: architectureValidatorConfig,
            orchestratorLog: orchLog,
            logger: architectureValidatorLog ?? undefined,
          });
        } catch (err) {
          architectureError = err instanceof Error ? err.message : String(err);
          logOrchestratorEvent(orchLog, "validator.error", {
            validator: "architecture",
            taskId: r.taskId,
            message: architectureError,
          });
        } finally {
          recordChecksetDuration(runMetrics, Date.now() - architectureStartedAt);
        }

        const outcome = await summarizeArchitectureValidatorResult(
          reportPath,
          architectureResult,
          architectureError,
        );
        const relativeReport = relativeReportPath(projectName, runId, outcome.reportPath);

        setValidatorResult(state, r.taskId, {
          validator: "architecture",
          status: outcome.status,
          mode: architectureValidatorMode,
          summary: outcome.summary ?? undefined,
          report_path: relativeReport,
        });

        if (shouldBlockValidator(architectureValidatorMode, outcome.status)) {
          blockedTasks.add(r.taskId);
          const reason =
            outcome.summary !== null && outcome.summary.trim().length > 0
              ? `Architecture validator blocked merge: ${outcome.summary}`
              : "Architecture validator blocked merge (mode=block)";
          markTaskNeedsHumanReview(state, r.taskId, {
            validator: "architecture",
            reason,
            summary: outcome.summary ?? undefined,
            reportPath: relativeReport,
          });
          logOrchestratorEvent(orchLog, "validator.block", {
            validator: "architecture",
            taskId: r.taskId,
            mode: architectureValidatorMode,
            status: outcome.status,
          });
        }
      }
    }

    const validatedTaskIds = readyForValidation
      .map((task) => task.taskId)
      .filter((taskId) => !blockedTasks.has(taskId));
    for (const taskId of validatedTaskIds) {
      markTaskValidated(state, taskId);
    }

    await stateStore.save(state);
    refreshStatusSets();

    let batchMergeCommit: string | undefined;
    let integrationDoctorPassed: boolean | undefined;
    let stopReason:
      | "merge_conflict"
      | "integration_doctor_failed"
      | "budget_block"
      | undefined;
    let mergeConflictDetail: { taskId: string; branchName: string; message: string } | null = null;
    let integrationDoctorFailureDetail: { exitCode: number; output: string } | null = null;

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
        const recipients = buildValidatedTaskSummaries(params.batchTasks);

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

    await stateStore.save(state);
    refreshStatusSets();

    const successfulTasks = buildValidatedTaskSummaries(params.batchTasks);

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
        mergeConflictDetail = {
          taskId: mergeResult.conflict.taskId,
          branchName: mergeResult.conflict.branchName,
          message: mergeResult.message,
        };
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
          if (doctorCanaryConfig.mode === "off") {
            doctorCanaryResult = { status: "skipped", reason: "Disabled by config" };
            lastIntegrationDoctorCanary = doctorCanaryResult;
            logOrchestratorEvent(orchLog, "doctor.canary.skipped", {
              batch_id: params.batchId,
              payload: {
                reason: "disabled_by_config",
                message: "Doctor canary disabled via doctor_canary.mode=off.",
              },
            });
          } else {
            logOrchestratorEvent(orchLog, "doctor.canary.start", {
              batch_id: params.batchId,
              env_var: doctorCanaryConfig.env_var,
            });
            const doctorCanaryStartedAt = Date.now();
            doctorCanaryResult = await runDoctorCanary({
              command: config.doctor,
              cwd: repoPath,
              timeoutSeconds: config.doctor_timeout,
              envVar: doctorCanaryConfig.env_var,
            });
            recordDoctorDuration(runMetrics, Date.now() - doctorCanaryStartedAt);
            lastIntegrationDoctorCanary = doctorCanaryResult;

            if (doctorCanaryResult.status === "unexpected_pass") {
              const envLabel = formatDoctorCanaryEnvVar(doctorCanaryResult.envVar);
              const severity = doctorCanaryConfig.warn_on_unexpected_pass ? "warn" : "error";
              logOrchestratorEvent(orchLog, "doctor.canary.unexpected_pass", {
                batch_id: params.batchId,
                payload: {
                  exit_code: doctorCanaryResult.exitCode,
                  env_var: doctorCanaryResult.envVar,
                  severity,
                  message: `Doctor did not fail when ${envLabel} (expected non-zero exit).`,
                  recommendation: `Wrap your doctor in a script that exits non-zero when ${envLabel} is set (see README).`,
                  output_preview: doctorCanaryResult.output.slice(0, 500),
                },
              });
            } else if (doctorCanaryResult.status === "expected_fail") {
              logOrchestratorEvent(orchLog, "doctor.canary.expected_fail", {
                batch_id: params.batchId,
                payload: {
                  exit_code: doctorCanaryResult.exitCode,
                  env_var: doctorCanaryResult.envVar,
                  output_preview: doctorCanaryResult.output.slice(0, 500),
                },
              });
            }
          }
        } else {
          doctorCanaryResult = { status: "skipped", reason: "Integration doctor failed" };
          lastIntegrationDoctorCanary = doctorCanaryResult;
          logOrchestratorEvent(orchLog, "doctor.canary.skipped", {
            batch_id: params.batchId,
            payload: {
              reason: "integration_doctor_failed",
              message: "Skipping canary because integration doctor failed.",
            },
          });
        }

        if (!doctorOk) {
          integrationDoctorFailureDetail = {
            exitCode: doctorExitCode,
            output: lastIntegrationDoctorOutput ?? "",
          };
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
        triggerNotes: `Doctor exited successfully with ${formatDoctorCanaryEnvVar(
          doctorCanaryResult?.envVar,
        )} (expected non-zero).`,
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

    const markTasksForHumanReview = (
      tasks: TaskSuccessResult[],
      reason: string,
      summary?: string,
    ): void => {
      for (const task of tasks) {
        markTaskNeedsHumanReview(state, task.taskId, {
          validator: "doctor",
          reason,
          summary,
        });
      }
    };

    let finalizedTasks = false;
    if (stopReason === "merge_conflict" && mergeConflictDetail && successfulTasks.length > 0) {
      const reason = `Merge conflict while merging ${mergeConflictDetail.branchName} (task ${mergeConflictDetail.taskId}).`;
      const summary = mergeConflictDetail.message;
      markTasksForHumanReview(successfulTasks, reason, summary);
      finalizedTasks = true;
    }

    if (
      stopReason === "integration_doctor_failed" &&
      integrationDoctorFailureDetail &&
      successfulTasks.length > 0
    ) {
      const rawOutput = integrationDoctorFailureDetail.output.trim();
      const summary = rawOutput.length > 0 ? rawOutput.slice(0, 500) : undefined;
      const reason = `Integration doctor failed (exit ${integrationDoctorFailureDetail.exitCode}).`;
      markTasksForHumanReview(successfulTasks, reason, summary);
      finalizedTasks = true;
    }

    if (!stopReason && integrationDoctorPassed === true && successfulTasks.length > 0) {
      for (const task of successfulTasks) {
        markTaskComplete(state, task.taskId);
        logOrchestratorEvent(orchLog, "task.complete", {
          taskId: task.taskId,
          attempts: state.tasks[task.taskId].attempts,
        });
      }
      finalizedTasks = true;
    }

    if (finalizedTasks) {
      await stateStore.save(state);
      refreshStatusSets();
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
      integrationDoctorCanary: buildDoctorCanarySummary(doctorCanaryResult),
    });
    await stateStore.save(state);

    if (integrationDoctorPassed === true && batchMergeCommit) {
      const ledgerCandidates = params.batchTasks.filter((task) => {
        const status = state.tasks[task.manifest.id]?.status;
        return status === "complete" || status === "skipped";
      });

      if (ledgerCandidates.length > 0) {
        logOrchestratorEvent(orchLog, "ledger.write.start", {
          batch_id: params.batchId,
          merge_commit: batchMergeCommit,
          tasks: ledgerCandidates.map((task) => task.manifest.id),
        });

        const ledgerCompleted: string[] = [];
        for (const task of ledgerCandidates) {
          const taskId = task.manifest.id;
          const manifestPath = resolveTaskManifestPath({
            tasksRoot: tasksRootAbs,
            stage: task.stage,
            taskDirName: task.taskDirName,
          });
          const specPath = resolveTaskSpecPath({
            tasksRoot: tasksRootAbs,
            stage: task.stage,
            taskDirName: task.taskDirName,
          });

          try {
            const fingerprint = await computeTaskFingerprint({ manifestPath, specPath });
            const completedAt = state.tasks[taskId]?.completed_at ?? isoNow();
            await upsertLedgerEntry(projectName, {
              taskId,
              status: state.tasks[taskId].status === "skipped" ? "skipped" : "complete",
              fingerprint,
              mergeCommit: batchMergeCommit,
              integrationDoctorPassed: true,
              completedAt,
              runId,
              source: "executor",
            });
            ledgerCompleted.push(taskId);
          } catch (error) {
            logOrchestratorEvent(orchLog, "ledger.write.error", {
              batch_id: params.batchId,
              taskId,
              message: formatErrorMessage(error),
            });
          }
        }

        logOrchestratorEvent(orchLog, "ledger.write.complete", {
          batch_id: params.batchId,
          merge_commit: batchMergeCommit,
          tasks: ledgerCompleted,
        });
      }
    }

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

    if (integrationDoctorPassed === true && !stopReason && successfulTasks.length > 0) {
      const archiveIds = new Set(successfulTasks.map((task) => task.taskId));

      for (const task of params.batchTasks) {
        if (!archiveIds.has(task.manifest.id)) continue;
        if (task.stage === "legacy") continue;

        try {
          await ensureTaskActiveStage(task);
          const moveResult = await moveTaskDir({
            tasksRoot: tasksRootAbs,
            fromStage: "active",
            toStage: "archive",
            taskDirName: task.taskDirName,
            runId,
          });

          if (moveResult.moved) {
            logOrchestratorEvent(orchLog, "task.stage.move", {
              taskId: task.manifest.id,
              from: "active",
              to: "archive",
              path_from: moveResult.fromPath,
              path_to: moveResult.toPath,
            });
          }
        } catch (error) {
          logOrchestratorEvent(orchLog, "task.stage.move_error", {
            taskId: task.manifest.id,
            message: formatErrorMessage(error),
          });
        }
      }
    }

    await cleanupSuccessfulBatchArtifacts({
      batchStatus,
      integrationDoctorPassed,
      successfulTasks,
    });

    logOrchestratorEvent(orchLog, "batch.complete", { batch_id: params.batchId });
    return stopReason;
  };

  const externalDepsLogged = new Set<string>();
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

    let externalCompletedDeps = new Set<string>();
    if (reuseCompleted) {
      const ledgerContext = await ensureLedgerContext();
      const externalDeps = await resolveExternalCompletedDeps({
        pendingTasks,
        state,
        ledger: ledgerContext.ledger,
        repoPath,
        headSha: ledgerContext.headSha,
        taskFileIndex: ledgerContext.taskFileIndex,
        eligibilityCache: ledgerEligibilityCache,
        reachabilityCache: ledgerReachabilityCache,
        fingerprintCache: ledgerFingerprintCache,
      });

      externalCompletedDeps = externalDeps.externalCompleted;
      for (const [taskId, deps] of externalDeps.satisfiedByTask.entries()) {
        if (externalDepsLogged.has(taskId)) continue;
        externalDepsLogged.add(taskId);
        logOrchestratorEvent(orchLog, "deps.external_satisfied", {
          task_id: taskId,
          deps: deps.map((dep) => ({
            dep_id: dep.depId,
            merge_commit: dep.mergeCommit ?? null,
            ledger_run_id: dep.runId ?? null,
            completed_at: dep.completedAt ?? null,
          })),
        });
      }
    }

    const effectiveCompleted = new Set([...completed, ...externalCompletedDeps]);
    const ready = topologicalReady(pendingTasks, effectiveCompleted);
    if (ready.length === 0) {
      const dependencyIssues = collectDependencyIssues(pendingTasks, state, effectiveCompleted);
      if (
        dependencyIssues.blocked.length > 0 &&
        dependencyIssues.missing.length === 0 &&
        dependencyIssues.pending.length === 0
      ) {
        const blockedTasksPayload = dependencyIssues.blocked.map((entry) => ({
          task_id: entry.taskId,
          unmet_deps: entry.unmetDeps.map((dep) => ({
            dep_id: dep.depId,
            dep_status: dep.depStatus,
            ...(dep.depLastError ? { dep_last_error: dep.depLastError } : {}),
          })),
        }));

        logOrchestratorEvent(orchLog, "run.paused", {
          reason: "blocked_dependencies",
          message:
            "No dependency-satisfied tasks remain; pending tasks are blocked by tasks requiring attention.",
          pending_task_count: pendingTasks.length,
          blocked_task_count: blockedTasksPayload.length,
          blocked_tasks: blockedTasksPayload,
          resume_command: `mycelium resume --project ${projectName} --run-id ${runId}`,
        });
        state.status = "paused";
        await stateStore.save(state);
        break;
      }

      if (dependencyIssues.missing.length > 0) {
        const missingPayload = dependencyIssues.missing.map((entry) => ({
          task_id: entry.taskId,
          missing_deps: entry.missingDeps,
        }));
        logOrchestratorEvent(orchLog, "run.blocked", {
          reason: "missing_dependencies",
          message:
            "No dependency-satisfied tasks remain; some dependencies are missing from this run.",
          pending_task_count: pendingTasks.length,
          blocked_task_count: missingPayload.length,
          blocked_tasks: missingPayload,
        });
        state.status = "failed";
        await stateStore.save(state);
        break;
      }

      const pendingPayload = dependencyIssues.pending.map((entry) => ({
        task_id: entry.taskId,
        pending_deps: entry.pendingDeps,
      }));
      logOrchestratorEvent(orchLog, "run.blocked", {
        reason: "true_deadlock",
        message:
          "No dependency-satisfied tasks remain; pending tasks depend on each other or unresolved tasks.",
        pending_task_count: pendingTasks.length,
        blocked_task_count: pendingPayload.length,
        blocked_tasks: pendingPayload,
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
        await ensureTaskActiveStage(task);
        const branchName = buildTaskBranchName(
          config.task_branch_prefix,
          taskId,
          task.manifest.name,
        );
        const defaultDoctorCommand = task.manifest.verify?.doctor ?? config.doctor;
        const defaultLintCommand = task.manifest.verify?.lint ?? config.lint;
        const lintCommand = defaultLintCommand?.trim() || undefined;
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
        const taskAbsoluteDir = resolveTaskDir({
          tasksRoot: tasksRootAbs,
          stage: task.stage,
          taskDirName: task.taskDirName,
        });
        const taskRelativeDir = path.relative(tasksRootAbs, taskAbsoluteDir);
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

        const manifestPath = path.join(
          workspace,
          config.tasks_dir,
          taskRelativeDir,
          "manifest.json",
        );
        const specPath = path.join(workspace, config.tasks_dir, taskRelativeDir, "spec.md");

        let attemptResult: WorkerRunnerResult;
        try {
          attemptResult = await workerRunner.runAttempt({
            taskId,
            taskSlug,
            taskBranch: branchName,
            workspace,
            taskPaths: {
              manifestPath,
              specPath,
              taskRelativeDirPosix,
            },
            lintCommand: lintCommand,
            lintTimeoutSeconds: config.lint_timeout,
            doctorCommand: doctorCommand,
            doctorTimeoutSeconds: config.doctor_timeout,
            maxRetries: config.max_retries,
            bootstrapCmds: config.bootstrap,
            runLogsDir: tLogsDir,
            codexHome,
            codexModel: config.worker.model,
            codexModelReasoningEffort: codexReasoningEffort,
            checkpointCommits: config.worker.checkpoint_commits,
            defaultTestPaths: config.test_paths,
            logCodexPrompts: config.worker.log_codex_prompts,
            crashAfterStart: crashAfterContainerStart,
            taskEvents,
            orchestratorLogger: orchLog,
            onContainerReady: async (containerId) => {
              state.tasks[taskId].container_id = containerId;
              await stateStore.save(state);
            },
          });
        } finally {
          taskEvents.close();
        }

        if (attemptResult.containerId) {
          state.tasks[taskId].container_id = attemptResult.containerId;
        }

        await syncWorkerStateIntoTask(taskId, workspace);

        if (attemptResult.success) {
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
          errorMessage: attemptResult.errorMessage,
          success: false as const,
        };
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
    const blockedTasks = summarizeBlockedTasks(state.tasks);
    if (blockedTasks.length > 0) {
      const blockedTasksPayload = blockedTasks.map((task) => ({
        task_id: task.taskId,
        status: task.status,
        ...(task.lastError ? { last_error: task.lastError } : {}),
      }));
      state.status = "paused";
      logOrchestratorEvent(orchLog, "run.paused", {
        reason: "blocked_tasks",
        message: "Run paused with tasks requiring attention.",
        blocked_task_count: blockedTasksPayload.length,
        blocked_tasks: blockedTasksPayload,
        resume_command: `mycelium resume --project ${projectName} --run-id ${runId}`,
      });
    } else {
      state.status = "complete";
    }
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

async function summarizeStyleValidatorResult(
  reportPath: string,
  result: StyleValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<StyleValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeStyleReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Style validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

async function summarizeArchitectureValidatorResult(
  reportPath: string,
  result: ArchitectureValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<ArchitectureValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeArchitectureReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Architecture validator returned no result (see validator log).";
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
  envVar: string;
}): Promise<DoctorCanaryResult> {
  const res = await execaCommand(args.command, {
    cwd: args.cwd,
    shell: true,
    reject: false,
    env: { ...process.env, [args.envVar]: "1" },
    timeout: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
  });

  const exitCode = res.exitCode ?? -1;
  const output = limitText(`${res.stdout}\n${res.stderr}`.trim(), DOCTOR_CANARY_OUTPUT_LIMIT);

  if (exitCode === 0) {
    return { status: "unexpected_pass", exitCode, output, envVar: args.envVar };
  }

  return { status: "expected_fail", exitCode, output, envVar: args.envVar };
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



// =============================================================================
// LEDGER REUSE HELPERS
// =============================================================================

type TaskFileLocation = {
  manifestPath: string;
  specPath: string;
};

type LedgerContext = {
  ledger: TaskLedger | null;
  headSha: string;
  taskFileIndex: Map<string, TaskFileLocation>;
};

type LedgerEligibilityResult = {
  eligible: boolean;
  entry?: TaskLedgerEntry;
};

type ExternalDependency = {
  depId: string;
  mergeCommit?: string;
  runId?: string;
  completedAt?: string;
};

type ExternalDependencySummary = {
  externalCompleted: Set<string>;
  satisfiedByTask: Map<string, ExternalDependency[]>;
};

async function buildTaskFileIndex(args: {
  tasksRoot: string;
  tasks: TaskSpec[];
}): Promise<Map<string, TaskFileLocation>> {
  const index = new Map<string, TaskFileLocation>();

  for (const task of args.tasks) {
    const manifestPath = resolveTaskManifestPath({
      tasksRoot: args.tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    });
    const specPath = resolveTaskSpecPath({
      tasksRoot: args.tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    });

    const [manifestExists, specExists] = await Promise.all([
      fse.pathExists(manifestPath),
      fse.pathExists(specPath),
    ]);
    if (!manifestExists || !specExists) {
      continue;
    }

    index.set(task.manifest.id, { manifestPath, specPath });
  }

  const archiveDir = resolveTasksArchiveDir(args.tasksRoot);
  if (!(await fse.pathExists(archiveDir))) {
    return index;
  }

  const archiveManifestPaths = await fg("archive/*/*/manifest.json", {
    cwd: args.tasksRoot,
    absolute: true,
  });

  for (const manifestPath of archiveManifestPaths) {
    const taskId = await readTaskIdFromManifest(manifestPath);
    if (!taskId || index.has(taskId)) {
      continue;
    }

    const specPath = path.join(path.dirname(manifestPath), "spec.md");
    if (!(await fse.pathExists(specPath))) {
      continue;
    }

    index.set(taskId, { manifestPath, specPath });
  }

  return index;
}

async function readTaskIdFromManifest(manifestPath: string): Promise<string | null> {
  try {
    const raw = await fse.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

async function resolveTaskFingerprint(args: {
  taskId: string;
  taskFileIndex: Map<string, TaskFileLocation>;
  fingerprintCache: Map<string, string>;
}): Promise<string | null> {
  const cached = args.fingerprintCache.get(args.taskId);
  if (cached) return cached;

  const taskFiles = args.taskFileIndex.get(args.taskId);
  if (!taskFiles) return null;

  try {
    const fingerprint = await computeTaskFingerprint({
      manifestPath: taskFiles.manifestPath,
      specPath: taskFiles.specPath,
    });
    args.fingerprintCache.set(args.taskId, fingerprint);
    return fingerprint;
  } catch {
    return null;
  }
}

async function isMergeCommitReachable(args: {
  repoPath: string;
  mergeCommit: string;
  headSha: string;
  reachabilityCache: Map<string, boolean>;
}): Promise<boolean> {
  const cached = args.reachabilityCache.get(args.mergeCommit);
  if (cached !== undefined) return cached;

  const reachable = await isAncestor(args.repoPath, args.mergeCommit, args.headSha);
  args.reachabilityCache.set(args.mergeCommit, reachable);
  return reachable;
}

async function resolveLedgerEligibility(args: {
  taskId: string;
  ledger: TaskLedger | null;
  repoPath: string;
  headSha: string;
  taskFileIndex: Map<string, TaskFileLocation>;
  eligibilityCache: Map<string, LedgerEligibilityResult>;
  reachabilityCache: Map<string, boolean>;
  fingerprintCache: Map<string, string>;
}): Promise<LedgerEligibilityResult> {
  const cached = args.eligibilityCache.get(args.taskId);
  if (cached) return cached;

  if (!args.ledger) {
    const result = { eligible: false };
    args.eligibilityCache.set(args.taskId, result);
    return result;
  }

  const entry = args.ledger.tasks[args.taskId];
  if (!entry) {
    const result = { eligible: false };
    args.eligibilityCache.set(args.taskId, result);
    return result;
  }

  if (entry.status !== "complete" && entry.status !== "skipped") {
    const result = { eligible: false };
    args.eligibilityCache.set(args.taskId, result);
    return result;
  }

  if (!entry.mergeCommit) {
    const result = { eligible: false };
    args.eligibilityCache.set(args.taskId, result);
    return result;
  }

  const isReachable = await isMergeCommitReachable({
    repoPath: args.repoPath,
    mergeCommit: entry.mergeCommit,
    headSha: args.headSha,
    reachabilityCache: args.reachabilityCache,
  });
  if (!isReachable) {
    const result = { eligible: false };
    args.eligibilityCache.set(args.taskId, result);
    return result;
  }

  if (args.taskFileIndex.has(args.taskId)) {
    if (!entry.fingerprint) {
      const result = { eligible: false };
      args.eligibilityCache.set(args.taskId, result);
      return result;
    }

    const fingerprint = await resolveTaskFingerprint({
      taskId: args.taskId,
      taskFileIndex: args.taskFileIndex,
      fingerprintCache: args.fingerprintCache,
    });
    if (!fingerprint || fingerprint !== entry.fingerprint) {
      const result = { eligible: false };
      args.eligibilityCache.set(args.taskId, result);
      return result;
    }
  }

  const result = { eligible: true, entry };
  args.eligibilityCache.set(args.taskId, result);
  return result;
}

async function seedRunFromLedger(args: {
  tasks: TaskSpec[];
  state: RunState;
  ledger: TaskLedger | null;
  repoPath: string;
  headSha: string;
  taskFileIndex: Map<string, TaskFileLocation>;
  eligibilityCache: Map<string, LedgerEligibilityResult>;
  reachabilityCache: Map<string, boolean>;
  fingerprintCache: Map<string, string>;
}): Promise<{ seeded: Array<{ taskId: string; entry: TaskLedgerEntry }> }> {
  const seeded: Array<{ taskId: string; entry: TaskLedgerEntry }> = [];

  if (!args.ledger) {
    return { seeded };
  }

  for (const task of args.tasks) {
    const taskId = task.manifest.id;
    const taskState = args.state.tasks[taskId];
    if (!taskState || taskState.status !== "pending") {
      continue;
    }

    const eligibility = await resolveLedgerEligibility({
      taskId,
      ledger: args.ledger,
      repoPath: args.repoPath,
      headSha: args.headSha,
      taskFileIndex: args.taskFileIndex,
      eligibilityCache: args.eligibilityCache,
      reachabilityCache: args.reachabilityCache,
      fingerprintCache: args.fingerprintCache,
    });

    if (!eligibility.eligible || !eligibility.entry) {
      continue;
    }

    taskState.status = "complete";
    taskState.completed_at = eligibility.entry.completedAt ?? isoNow();
    seeded.push({ taskId, entry: eligibility.entry });
  }

  return { seeded };
}

async function resolveExternalCompletedDeps(args: {
  pendingTasks: TaskSpec[];
  state: RunState;
  ledger: TaskLedger | null;
  repoPath: string;
  headSha: string;
  taskFileIndex: Map<string, TaskFileLocation>;
  eligibilityCache: Map<string, LedgerEligibilityResult>;
  reachabilityCache: Map<string, boolean>;
  fingerprintCache: Map<string, string>;
}): Promise<ExternalDependencySummary> {
  const externalCompleted = new Set<string>();
  const satisfiedByTask = new Map<string, ExternalDependency[]>();

  if (!args.ledger) {
    return { externalCompleted, satisfiedByTask };
  }

  for (const task of args.pendingTasks) {
    const deps = task.manifest.dependencies ?? [];
    const externalDeps: ExternalDependency[] = [];

    for (const depId of deps) {
      if (args.state.tasks[depId]) {
        continue;
      }

      const eligibility = await resolveLedgerEligibility({
        taskId: depId,
        ledger: args.ledger,
        repoPath: args.repoPath,
        headSha: args.headSha,
        taskFileIndex: args.taskFileIndex,
        eligibilityCache: args.eligibilityCache,
        reachabilityCache: args.reachabilityCache,
        fingerprintCache: args.fingerprintCache,
      });

      if (!eligibility.eligible || !eligibility.entry) {
        continue;
      }

      externalCompleted.add(depId);
      externalDeps.push({
        depId,
        mergeCommit: eligibility.entry.mergeCommit,
        runId: eligibility.entry.runId,
        completedAt: eligibility.entry.completedAt,
      });
    }

    if (externalDeps.length > 0) {
      satisfiedByTask.set(task.manifest.id, externalDeps);
    }
  }

  return { externalCompleted, satisfiedByTask };
}


// =============================================================================
// STATUS HELPERS
// =============================================================================
// =============================================================================
// STATUS HELPERS
// =============================================================================

const BLOCKED_TASK_STATUSES: TaskStatus[] = [
  "failed",
  "needs_human_review",
  "needs_rescope",
  "rescope_required",
];

type BlockedDependencyDetail = {
  depId: string;
  depStatus: TaskStatus | "unknown";
  depLastError?: string;
};

type BlockedDependencySummary = {
  taskId: string;
  unmetDeps: BlockedDependencyDetail[];
};

type MissingDependencySummary = {
  taskId: string;
  missingDeps: string[];
};

type PendingDependencySummary = {
  taskId: string;
  pendingDeps: string[];
};

type BlockedTaskSummary = {
  taskId: string;
  status: TaskStatus;
  lastError?: string;
};

function isBlockedTaskStatus(status: TaskStatus): boolean {
  return BLOCKED_TASK_STATUSES.includes(status);
}

function collectDependencyIssues(
  pendingTasks: TaskSpec[],
  state: RunState,
  completed: Set<string>,
): {
  blocked: BlockedDependencySummary[];
  missing: MissingDependencySummary[];
  pending: PendingDependencySummary[];
} {
  const blocked: BlockedDependencySummary[] = [];
  const missing: MissingDependencySummary[] = [];
  const pending: PendingDependencySummary[] = [];

  for (const task of pendingTasks) {
    const deps = task.manifest.dependencies ?? [];
    const unmetDeps = deps.filter((dep) => !completed.has(dep));
    if (unmetDeps.length === 0) {
      continue;
    }

    const blockedDeps: BlockedDependencyDetail[] = [];
    const missingDeps: string[] = [];
    const pendingDeps: string[] = [];

    for (const depId of unmetDeps) {
      const depState = state.tasks[depId];
      if (!depState) {
        missingDeps.push(depId);
        continue;
      }

      if (isBlockedTaskStatus(depState.status)) {
        blockedDeps.push({
          depId,
          depStatus: depState.status,
          ...(depState.last_error ? { depLastError: depState.last_error } : {}),
        });
      } else {
        pendingDeps.push(depId);
      }
    }

    if (blockedDeps.length > 0) {
      blocked.push({ taskId: task.manifest.id, unmetDeps: blockedDeps });
    }
    if (missingDeps.length > 0) {
      missing.push({ taskId: task.manifest.id, missingDeps });
    }
    if (pendingDeps.length > 0) {
      pending.push({ taskId: task.manifest.id, pendingDeps });
    }
  }

  return { blocked, missing, pending };
}

function summarizeBlockedTasks(tasks: RunState["tasks"]): BlockedTaskSummary[] {
  return Object.entries(tasks)
    .filter(([, task]) => isBlockedTaskStatus(task.status))
    .map(([taskId, task]) => ({
      taskId,
      status: task.status,
      ...(task.last_error ? { lastError: task.last_error } : {}),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
}

function buildStatusSets(state: RunState): { completed: Set<string>; failed: Set<string> } {
  const completed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => s.status === "complete" || s.status === "validated" || s.status === "skipped")
      .map(([id]) => id),
  );
  const failed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => isBlockedTaskStatus(s.status))
      .map(([id]) => id),
  );
  return { completed, failed };
}

function createWorkerRunner(input: {
  useDocker: boolean;
  projectName: string;
  runId: string;
  config: ProjectConfig;
  tasksDirPosix: string;
  workerImage: string;
  containerResources?: ContainerSpec["resources"];
  containerSecurityPayload: JsonObject;
  networkMode?: ProjectConfig["docker"]["network_mode"];
  containerUser?: string;
}): WorkerRunner {
  if (!input.useDocker) {
    return new LocalWorkerRunner();
  }

  return new DockerWorkerRunner({
    projectName: input.projectName,
    runId: input.runId,
    workerImage: input.workerImage,
    dockerfile: input.config.docker.dockerfile,
    buildContext: input.config.docker.build_context,
    tasksDirPosix: input.tasksDirPosix,
    containerResources: input.containerResources,
    containerSecurityPayload: input.containerSecurityPayload,
    networkMode: input.networkMode,
    containerUser: input.containerUser,
  });
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
