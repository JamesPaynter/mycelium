/**
 * RunEngine orchestrates a run by delegating task + batch execution.
 * Purpose: centralize run control-flow behind RunContext.
 * Assumptions: run engine owns run state + store, passed in via context.
 * Usage: runEngine(context) from executor.
 */

import fs from "node:fs/promises";

import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../../../control-plane/integration/derived-scope.js";
import {
  createComponentOwnerResolver,
  createComponentOwnershipResolver,
  deriveComponentResources,
} from "../../../control-plane/integration/resources.js";
import { buildControlPlaneModel } from "../../../control-plane/model/build.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import type { PolicyDecision } from "../../../control-plane/policy/types.js";
import { ControlPlaneStore } from "../../../control-plane/storage.js";
import type {
  ControlPlaneLockMode,
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
  ManifestEnforcementPolicy,
  ProjectConfig,
  ResourceConfig,
} from "../../../core/config.js";
import {
  JsonlLogger,
  logOrchestratorEvent,
  logRunResume,
  type JsonObject,
} from "../../../core/logger.js";
import type { ResourceOwnershipResolver } from "../../../core/manifest-compliance.js";
import type { PathsContext } from "../../../core/paths.js";
import {
  orchestratorHome,
  orchestratorLogPath,
  runSummaryReportPath,
  taskLockDerivationReportPath,
} from "../../../core/paths.js";
import {
  buildGreedyBatch,
  topologicalReady,
  type BatchPlan,
  type LockResolver,
} from "../../../core/scheduler.js";
import { StateStore } from "../../../core/state-store.js";
import {
  createRunState,
  startBatch,
  type ControlPlaneSnapshot,
  type RunState,
  type TaskStatus,
} from "../../../core/state.js";
import { buildTaskFileIndex, type TaskFileLocation } from "../../../core/task-file-index.js";
import { resolveTasksArchiveDir } from "../../../core/task-layout.js";
import {
  computeTaskFingerprint,
  importLedgerFromRunState,
  loadTaskLedger,
  type TaskLedger,
  type TaskLedgerEntry,
} from "../../../core/task-ledger.js";
import { loadTaskSpecs } from "../../../core/task-loader.js";
import { normalizeLocks, type TaskSpec } from "../../../core/task-manifest.js";
import { ensureDir, isoNow, readJsonFile, writeJsonFile } from "../../../core/utils.js";
import type { ContainerSpec } from "../../../docker/docker.js";
import { BudgetTracker } from "../budgets/budget-tracker.js";
import { CompliancePipeline } from "../compliance/compliance-pipeline.js";
import { formatErrorMessage, normalizeAbortReason } from "../helpers/errors.js";
import { averageRounded, secondsFromMs } from "../helpers/time.js";
import type { ControlPlaneRunConfig, RunContext } from "../run-context.js";
import { ValidationPipeline } from "../validation/validation-pipeline.js";
import type { Vcs } from "../vcs/vcs.js";
import { DockerWorkerRunner } from "../workers/docker-worker-runner.js";
import { LocalWorkerRunner } from "../workers/local-worker-runner.js";
import type { WorkerRunner } from "../workers/worker-runner.js";

import { createBatchEngine } from "./batch-engine.js";
export { shouldResetTaskToPending } from "./failure-policy.js";
import { createTaskEngine } from "./task-engine.js";

const RUN_HEARTBEAT_INTERVAL_MS = 30_000;

// =============================================================================
// PUBLIC TYPES
// =============================================================================

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
  useLegacyEngine?: boolean;
  crashAfterContainerStart?: boolean;
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

// =============================================================================
// RUN ENGINE
// =============================================================================

export async function runEngine(context: RunContext<RunOptions, RunResult>): Promise<RunResult> {
  if (context.options.useLegacyEngine === true) {
    return context.legacy.runProject(context.projectName, context.config, context.options);
  }

  return runEngineImpl(context);
}

export async function runLegacyEngine(
  context: RunContext<RunOptions, RunResult>,
): Promise<RunResult> {
  return runEngineImpl(context);
}

async function runEngineImpl(context: RunContext<RunOptions, RunResult>): Promise<RunResult> {
  const stopController = buildStopController(context.options.stopSignal);
  let heartbeat: RunHeartbeat | null = null;

  try {
    const {
      projectName,
      config,
      options,
      ports: { vcs },
      resolved: {
        run: { runId, isResume, reuseCompleted, importRunId: rawImportRunId, maxParallel },
        cleanup: {
          workspacesOnSuccess: cleanupWorkspacesOnSuccess,
          containersOnSuccess: cleanupContainersOnSuccess,
        },
        paths: { repoPath, tasksRootAbs, tasksDirPosix, myceliumHome },
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
      },
    } = context;

    const importRunId = rawImportRunId ?? null;
    const pathsContext: PathsContext = { myceliumHome };
    let controlPlaneConfig = context.resolved.controlPlane.config;
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
    let validationPipeline: ValidationPipeline | null = null;
    const closeValidationPipeline = (): void => {
      validationPipeline?.close();
    };

    const { stateStore, orchLog } = await createRunInfrastructure({
      projectName,
      runId,
      repoPath,
      paths: pathsContext,
    });

    const runResumeReason = isResume ? "resume_command" : "existing_state";
    const initResult = await initializeRunStateAndSnapshot({
      projectName,
      runId,
      repoPath,
      config,
      isResume,
      runResumeReason,
      controlPlaneConfig,
      stateStore,
      orchLog,
      plannedBatches,
      vcs,
      closeValidationPipeline,
    });
    if ("earlyResult" in initResult) return initResult.earlyResult;

    const state = initResult.state;
    const hadExistingState = initResult.hadExistingState;
    const controlPlaneSnapshot = initResult.controlPlaneSnapshot;
    controlPlaneConfig = initResult.controlPlaneConfig;

    heartbeat = startRunHeartbeat({
      state,
      stateStore,
      orchestratorLog: orchLog,
      intervalMs: RUN_HEARTBEAT_INTERVAL_MS,
    });

    const lockMode = resolveEffectiveLockMode(controlPlaneConfig);
    const scopeComplianceMode = resolveScopeComplianceMode(controlPlaneConfig);

    const resourcesResult = await prepareRunResources({
      repoPath,
      config,
      options,
      runId,
      state,
      plannedBatches,
      controlPlaneConfig,
      controlPlaneSnapshot,
      orchLog,
      closeValidationPipeline,
      lockMode,
    });
    if ("earlyResult" in resourcesResult) return resourcesResult.earlyResult;

    const {
      resourceContext,
      tasks,
      taskCatalog,
      blastContext,
      derivedScopeReports,
      runMetrics,
      policyDecisions,
      lockResolver,
    } = resourcesResult;

    const runPipelines = createRunPipelines({
      projectName,
      repoPath,
      runId,
      tasksRootAbs,
      config,
      paths: pathsContext,
      validatorRunner: context.ports.validatorRunner,
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
      orchestratorLog: orchLog,
      runMetrics,
      resourceContext,
      costPer1kTokens,
    });
    validationPipeline = runPipelines.validationPipeline;
    const { compliancePipeline, budgetTracker } = runPipelines;

    logOrchestratorEvent(orchLog, "run.tasks_loaded", {
      total_tasks: tasks.length,
      requested_tasks: options.tasks?.length ?? null,
    });

    // Ensure worker runtime is ready (no-op for local runs).
    const shouldBuildImage = options.buildImage ?? true;
    await workerRunner.prepare({
      buildImage: shouldBuildImage,
      orchestratorLogger: orchLog,
    });

    await syncRunStateWithTasks({
      tasks,
      state,
      stateStore,
      orchLog,
      runResumeReason,
      hadExistingState,
      budgetTracker,
    });

    const ledgerRuntime = await prepareLedgerRuntime({
      projectName,
      repoPath,
      tasksRootAbs,
      runId,
      tasks,
      taskCatalog,
      state,
      stateStore,
      paths: pathsContext,
      reuseCompleted,
      importRunId,
      isResume,
      hadExistingState,
      orchLog,
      vcs,
    });

    const stopHandlers = createStopHandlers({
      runId,
      state,
      stateStore,
      orchLog,
      plannedBatches,
      workerRunner,
      stopController,
      stopContainersOnExit,
      closeValidationPipeline,
    });

    const earlyStop = await stopHandlers.stopIfRequested();
    if (earlyStop) return earlyStop;

    const { taskEngine, batchEngine } = createRunEngines({
      projectName,
      runId,
      repoPath,
      tasksRootAbs,
      paths: pathsContext,
      config,
      state,
      stateStore,
      workerRunner,
      vcs,
      orchestratorLog: orchLog,
      mockLlmMode,
      crashAfterContainerStart,
      controlPlaneConfig,
      derivedScopeReports,
      blastContext,
      policyDecisions,
      validationPipeline,
      compliancePipeline,
      budgetTracker,
      runMetrics,
      scopeComplianceMode,
      manifestPolicy,
      doctorValidatorConfig,
      doctorValidatorEnabled,
      doctorCanaryConfig,
      cleanupWorkspacesOnSuccess,
      cleanupContainersOnSuccess,
      shouldSkipCleanup: stopHandlers.shouldSkipCleanup,
      buildStatusSets,
    });

    const externalDepsLogged = new Set<string>();

    const loopResult = await executeRunLoop({
      projectName,
      runId,
      options,
      repoPath,
      state,
      stateStore,
      orchLog,
      vcs,
      tasks,
      plannedBatches,
      maxParallel,
      lockMode,
      lockResolver,
      reuseCompleted,
      taskEngine,
      batchEngine,
      buildStatusSets,
      ensureLedgerContext: ledgerRuntime.ensureLedgerContext,
      ledgerEligibilityCache: ledgerRuntime.eligibilityCache,
      ledgerReachabilityCache: ledgerRuntime.reachabilityCache,
      ledgerFingerprintCache: ledgerRuntime.fingerprintCache,
      externalDepsLogged,
      stopIfRequested: stopHandlers.stopIfRequested,
    });
    if (loopResult) return loopResult;

    return await finalizeRun({
      projectName,
      runId,
      repoPath,
      state,
      stateStore,
      orchLog,
      plannedBatches,
      lockMode,
      scopeComplianceMode,
      controlPlaneEnabled: controlPlaneConfig.enabled,
      runMetrics,
      stopIfRequested: stopHandlers.stopIfRequested,
      closeValidationPipeline,
    });
  } finally {
    heartbeat?.stop();
    stopController.cleanup();
  }
}

// =============================================================================
// RUN SETUP HELPERS
// =============================================================================

type ResolvedValidators = RunContext<RunOptions, RunResult>["resolved"]["validators"];
type ValidatorRunner = RunContext<RunOptions, RunResult>["ports"]["validatorRunner"];

type RunInfrastructure = {
  stateStore: StateStore;
  orchLog: JsonlLogger;
};

type RunResourcesResult =
  | {
      earlyResult: RunResult;
    }
  | {
      resourceContext: ResourceResolutionContext;
      tasks: TaskSpec[];
      taskCatalog: TaskSpec[];
      blastContext: BlastRadiusContext | null;
      derivedScopeReports: Map<string, DerivedScopeReport>;
      runMetrics: RunMetrics;
      policyDecisions: Map<string, PolicyDecision>;
      lockResolver: LockResolver;
    };

type RunPipelines = {
  validationPipeline: ValidationPipeline;
  compliancePipeline: CompliancePipeline;
  budgetTracker: BudgetTracker;
};

type RunEngines = {
  taskEngine: ReturnType<typeof createTaskEngine>;
  batchEngine: ReturnType<typeof createBatchEngine>;
};

type StopHandlers = {
  stopIfRequested: () => Promise<RunResult | null>;
  shouldSkipCleanup: () => boolean;
};

type LedgerRuntime = {
  ensureLedgerContext: () => Promise<LedgerContext>;
  resetLedgerCache: () => void;
  eligibilityCache: Map<string, LedgerEligibilityResult>;
  reachabilityCache: Map<string, boolean>;
  fingerprintCache: Map<string, string>;
};

async function createRunInfrastructure(input: {
  projectName: string;
  runId: string;
  repoPath: string;
  paths: PathsContext;
}): Promise<RunInfrastructure> {
  await ensureDir(orchestratorHome(input.paths));
  const stateStore = new StateStore(input.projectName, input.runId, input.paths);
  const orchLog = new JsonlLogger(
    orchestratorLogPath(input.projectName, input.runId, input.paths),
    { runId: input.runId },
  );

  logOrchestratorEvent(orchLog, "run.start", {
    project: input.projectName,
    repo_path: input.repoPath,
  });

  return { stateStore, orchLog };
}

async function prepareRunResources(input: {
  repoPath: string;
  config: ProjectConfig;
  options: RunOptions;
  runId: string;
  state: RunState;
  plannedBatches: BatchPlanEntry[];
  controlPlaneConfig: ControlPlaneRunConfig;
  controlPlaneSnapshot: ControlPlaneSnapshot | undefined;
  orchLog: JsonlLogger;
  closeValidationPipeline: () => void;
  lockMode: ControlPlaneLockMode;
}): Promise<RunResourcesResult> {
  const resourceContext = await buildResourceResolutionContext({
    repoPath: input.repoPath,
    controlPlaneConfig: input.controlPlaneConfig,
    controlPlaneSnapshot: input.controlPlaneSnapshot,
    staticResources: input.config.resources,
  });

  const tasksResult = await loadTasksForRun({
    repoPath: input.repoPath,
    config: input.config,
    options: input.options,
    knownResources: resourceContext.knownResources,
    orchLog: input.orchLog,
    runId: input.runId,
    state: input.state,
    plannedBatches: input.plannedBatches,
    closeValidationPipeline: input.closeValidationPipeline,
  });
  if ("earlyResult" in tasksResult) return tasksResult;

  const { tasks, taskCatalog } = tasksResult;
  const blastContext = await loadBlastRadiusContext({
    controlPlaneConfig: input.controlPlaneConfig,
    controlPlaneSnapshot: input.controlPlaneSnapshot,
  });
  const derivedScopeReports = await emitDerivedScopeReports({
    repoPath: input.repoPath,
    runId: input.runId,
    tasks,
    controlPlaneConfig: input.controlPlaneConfig,
    controlPlaneSnapshot: input.controlPlaneSnapshot,
    orchestratorLog: input.orchLog,
  });
  const runMetrics = createRunMetrics({
    derivedScopeReports,
    fallbackResource: input.controlPlaneConfig.fallbackResource,
  });
  const policyDecisions = new Map<string, PolicyDecision>();
  const lockResolver = buildTaskLockResolver({
    lockMode: input.lockMode,
    derivedScopeReports,
    fallbackResource: input.controlPlaneConfig.fallbackResource,
  });

  return {
    resourceContext,
    tasks,
    taskCatalog,
    blastContext,
    derivedScopeReports,
    runMetrics,
    policyDecisions,
    lockResolver,
  };
}

function createRunPipelines(input: {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRootAbs: string;
  config: ProjectConfig;
  paths: PathsContext;
  validatorRunner: ValidatorRunner;
  validators: ResolvedValidators;
  orchestratorLog: JsonlLogger;
  runMetrics: RunMetrics;
  resourceContext: ResourceResolutionContext;
  costPer1kTokens: number;
}): RunPipelines {
  const validationPipeline = new ValidationPipeline({
    projectName: input.projectName,
    repoPath: input.repoPath,
    runId: input.runId,
    tasksRoot: input.tasksRootAbs,
    mainBranch: input.config.main_branch,
    paths: input.paths,
    validators: input.validators,
    orchestratorLog: input.orchestratorLog,
    runner: input.validatorRunner,
    onChecksetDuration: (durationMs) => {
      recordChecksetDuration(input.runMetrics, durationMs);
    },
    onDoctorDuration: (durationMs) => {
      recordDoctorDuration(input.runMetrics, durationMs);
    },
  });
  const compliancePipeline = new CompliancePipeline({
    projectName: input.projectName,
    runId: input.runId,
    tasksRoot: input.tasksRootAbs,
    mainBranch: input.config.main_branch,
    resourceContext: {
      resources: input.resourceContext.effectiveResources,
      staticResources: input.resourceContext.staticResources,
      fallbackResource: input.resourceContext.fallbackResource,
      ownerResolver: input.resourceContext.ownerResolver,
      ownershipResolver: input.resourceContext.ownershipResolver,
      resourcesMode: input.resourceContext.resourcesMode,
    },
    orchestratorLog: input.orchestratorLog,
    paths: input.paths,
  });
  const budgetTracker = new BudgetTracker({
    projectName: input.projectName,
    runId: input.runId,
    costPer1kTokens: input.costPer1kTokens,
    budgets: input.config.budgets,
    orchestratorLog: input.orchestratorLog,
    paths: input.paths,
  });

  return { validationPipeline, compliancePipeline, budgetTracker };
}

async function syncRunStateWithTasks(input: {
  tasks: TaskSpec[];
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  runResumeReason: string;
  hadExistingState: boolean;
  budgetTracker: BudgetTracker;
}): Promise<void> {
  for (const task of input.tasks) {
    if (input.state.tasks[task.manifest.id]) continue;
    input.state.tasks[task.manifest.id] = {
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
  await input.stateStore.save(input.state);

  if (!input.hadExistingState) return;

  const usageBackfilled = input.budgetTracker.backfillUsageFromLogs({
    tasks: input.tasks,
    state: input.state,
  });
  if (usageBackfilled) {
    await input.stateStore.save(input.state);
  }

  const runningTasks = Object.values(input.state.tasks).filter(
    (task) => task.status === "running",
  ).length;
  logRunResume(input.orchLog, {
    status: input.state.status,
    reason: input.runResumeReason,
    runningTasks,
  });
}

function createRunEngines(input: {
  projectName: string;
  runId: string;
  repoPath: string;
  tasksRootAbs: string;
  paths: PathsContext;
  config: ProjectConfig;
  state: RunState;
  stateStore: StateStore;
  workerRunner: WorkerRunner;
  vcs: Vcs;
  orchestratorLog: JsonlLogger;
  mockLlmMode: boolean;
  crashAfterContainerStart: boolean;
  controlPlaneConfig: ControlPlaneRunConfig;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  blastContext: BlastRadiusContext | null;
  policyDecisions: Map<string, PolicyDecision>;
  validationPipeline: ValidationPipeline | null;
  compliancePipeline: CompliancePipeline;
  budgetTracker: BudgetTracker;
  runMetrics: RunMetrics;
  scopeComplianceMode: ControlPlaneScopeMode;
  manifestPolicy: ManifestEnforcementPolicy;
  doctorValidatorConfig: ResolvedValidators["doctor"]["config"];
  doctorValidatorEnabled: ResolvedValidators["doctor"]["enabled"];
  doctorCanaryConfig: ResolvedValidators["doctorCanary"];
  cleanupWorkspacesOnSuccess: boolean;
  cleanupContainersOnSuccess: boolean;
  shouldSkipCleanup: () => boolean;
  buildStatusSets: (state: RunState) => { completed: Set<string>; failed: Set<string> };
}): RunEngines {
  const taskEngine = createTaskEngine({
    projectName: input.projectName,
    runId: input.runId,
    config: input.config,
    state: input.state,
    stateStore: input.stateStore,
    tasksRootAbs: input.tasksRootAbs,
    repoPath: input.repoPath,
    paths: input.paths,
    workerRunner: input.workerRunner,
    vcs: input.vcs,
    orchestratorLog: input.orchestratorLog,
    mockLlmMode: input.mockLlmMode,
    crashAfterContainerStart: input.crashAfterContainerStart,
    controlPlaneConfig: input.controlPlaneConfig,
    derivedScopeReports: input.derivedScopeReports,
    blastContext: input.blastContext,
    policyDecisions: input.policyDecisions,
  });

  const statusSets = input.buildStatusSets(input.state);
  const batchEngine = createBatchEngine(
    {
      projectName: input.projectName,
      runId: input.runId,
      repoPath: input.repoPath,
      tasksRootAbs: input.tasksRootAbs,
      paths: input.paths,
      config: input.config,
      state: input.state,
      stateStore: input.stateStore,
      orchestratorLog: input.orchestratorLog,
      taskEngine,
      validationPipeline: input.validationPipeline,
      compliancePipeline: input.compliancePipeline,
      budgetTracker: input.budgetTracker,
      runMetrics: input.runMetrics,
      recordDoctorDuration: (durationMs) => {
        recordDoctorDuration(input.runMetrics, durationMs);
      },
      controlPlaneConfig: input.controlPlaneConfig,
      derivedScopeReports: input.derivedScopeReports,
      scopeComplianceMode: input.scopeComplianceMode,
      manifestPolicy: input.manifestPolicy,
      policyDecisions: input.policyDecisions,
      blastContext: input.blastContext,
      doctorValidatorConfig: input.doctorValidatorConfig,
      doctorValidatorEnabled: input.doctorValidatorEnabled,
      doctorCanaryConfig: input.doctorCanaryConfig,
      cleanupWorkspacesOnSuccess: input.cleanupWorkspacesOnSuccess,
      cleanupContainersOnSuccess: input.cleanupContainersOnSuccess,
      workerRunner: input.workerRunner,
      shouldSkipCleanup: input.shouldSkipCleanup,
      vcs: input.vcs,
      buildStatusSets: input.buildStatusSets,
    },
    { doctorValidatorLastCount: statusSets.completed.size + statusSets.failed.size },
  );

  return { taskEngine, batchEngine };
}

function createStopHandlers(input: {
  runId: string;
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  plannedBatches: BatchPlanEntry[];
  workerRunner: WorkerRunner;
  stopController: StopController;
  stopContainersOnExit: boolean;
  closeValidationPipeline: () => void;
}): StopHandlers {
  let stopRequested: StopRequest | null = null;

  const resolveStopReason = (): StopRequest | null => {
    if (stopRequested) return stopRequested;
    const reason = input.stopController.reason;
    if (reason) {
      stopRequested = reason;
    }
    return stopRequested;
  };

  const stopRun = async (reason: StopRequest): Promise<RunResult> => {
    const stopSummary = await input.workerRunner.stop({
      stopContainersOnExit: input.stopContainersOnExit,
      orchestratorLogger: input.orchLog,
    });
    const containerAction: RunStopInfo["containers"] = stopSummary ? "stopped" : "left_running";
    input.state.status = "paused";

    const payload: JsonObject = {
      reason: reason.kind,
      stop_containers_requested: input.stopContainersOnExit,
      containers: containerAction,
    };
    if (reason.signal) payload.signal = reason.signal;
    if (stopSummary) {
      payload.containers_stopped = stopSummary.stopped;
      if (stopSummary.errors > 0) {
        payload.container_stop_errors = stopSummary.errors;
      }
    }

    logOrchestratorEvent(input.orchLog, "run.stop", payload);
    await input.stateStore.save(input.state);
    input.closeValidationPipeline();
    input.orchLog.close();

    return {
      runId: input.runId,
      state: input.state,
      plan: input.plannedBatches,
      stopped: {
        reason: "signal",
        signal: reason.signal,
        containers: containerAction,
        stopContainersRequested: input.stopContainersOnExit,
        stoppedContainers: stopSummary?.stopped,
        stopErrors: stopSummary?.errors ? stopSummary.errors : undefined,
      },
    };
  };

  const stopIfRequested = async (): Promise<RunResult | null> => {
    const reason = resolveStopReason();
    if (!reason) return null;
    return await stopRun(reason);
  };

  return {
    stopIfRequested,
    shouldSkipCleanup: () => stopRequested !== null || input.stopController.reason !== null,
  };
}

function createLedgerContextManager(input: {
  projectName: string;
  repoPath: string;
  tasksRootAbs: string;
  taskCatalog: TaskSpec[];
  paths: PathsContext;
  vcs: Vcs;
}): LedgerRuntime {
  const eligibilityCache = new Map<string, LedgerEligibilityResult>();
  const reachabilityCache = new Map<string, boolean>();
  const fingerprintCache = new Map<string, string>();
  let ledgerLoaded = false;
  let ledgerSnapshot: TaskLedger | null = null;
  let ledgerHeadSha: string | null = null;
  let taskFileIndex: Map<string, TaskFileLocation> | null = null;

  const ensureLedgerContext = async (): Promise<LedgerContext> => {
    if (!ledgerLoaded) {
      ledgerSnapshot = await loadTaskLedger(input.projectName, input.paths);
      ledgerLoaded = true;
    }
    if (!ledgerHeadSha) {
      ledgerHeadSha = await input.vcs.headSha(input.repoPath);
    }
    if (!taskFileIndex) {
      taskFileIndex = await buildTaskFileIndex({
        tasksRoot: input.tasksRootAbs,
        tasks: input.taskCatalog,
      });
    }

    return {
      ledger: ledgerSnapshot,
      headSha: ledgerHeadSha,
      taskFileIndex,
    };
  };

  const resetLedgerCache = (): void => {
    ledgerLoaded = false;
    ledgerSnapshot = null;
  };

  return {
    ensureLedgerContext,
    resetLedgerCache,
    eligibilityCache,
    reachabilityCache,
    fingerprintCache,
  };
}

async function importLedgerFromRunIfRequested(input: {
  importRunId: string | null;
  projectName: string;
  repoPath: string;
  tasksRootAbs: string;
  taskCatalog: TaskSpec[];
  paths: PathsContext;
  orchLog: JsonlLogger;
}): Promise<void> {
  if (!input.importRunId) return;

  logOrchestratorEvent(input.orchLog, "ledger.import.start", { run_id: input.importRunId });
  const importStore = new StateStore(input.projectName, input.importRunId, input.paths);
  if (!(await importStore.exists())) {
    logOrchestratorEvent(input.orchLog, "ledger.import.error", {
      run_id: input.importRunId,
      message: "Run state not found for import.",
    });
    throw new Error(`Cannot import run ${input.importRunId}: state file not found.`);
  }

  const importState = await importStore.load();
  const importResult = await importLedgerFromRunState({
    projectName: input.projectName,
    repoPath: input.repoPath,
    tasksRoot: input.tasksRootAbs,
    runId: input.importRunId,
    tasks: input.taskCatalog,
    state: importState,
    paths: input.paths,
  });
  logOrchestratorEvent(input.orchLog, "ledger.import.complete", {
    run_id: input.importRunId,
    imported: importResult.imported,
    skipped: importResult.skipped,
  });
}

async function maybeImportLedgerFromArchiveRuns(input: {
  reuseCompleted: boolean;
  importRunId: string | null;
  tasks: TaskSpec[];
  taskCatalog: TaskSpec[];
  projectName: string;
  repoPath: string;
  tasksRootAbs: string;
  paths: PathsContext;
  orchLog: JsonlLogger;
  ledgerRuntime: LedgerRuntime;
}): Promise<void> {
  if (!input.reuseCompleted || input.importRunId) return;

  const externalDeps = collectExternalDependencies(input.tasks);
  if (externalDeps.size === 0) return;

  const ledgerContext = await input.ledgerRuntime.ensureLedgerContext();
  const ledgerTasks = ledgerContext.ledger?.tasks ?? {};
  const missingFromLedger = [...externalDeps].filter((depId) => !ledgerTasks[depId]);

  if (missingFromLedger.length === 0) return;

  const archiveImport = await autoImportLedgerFromArchiveRuns({
    projectName: input.projectName,
    repoPath: input.repoPath,
    tasksRoot: input.tasksRootAbs,
    tasks: input.taskCatalog,
    paths: input.paths,
  });

  if (archiveImport.runIds.length > 0) {
    logOrchestratorEvent(input.orchLog, "ledger.import.archive", {
      run_count: archiveImport.runIds.length,
      imported: archiveImport.imported.length,
      skipped: archiveImport.skipped.length,
      skipped_runs: archiveImport.skippedRuns.length,
    });
  }

  if (archiveImport.imported.length > 0) {
    input.ledgerRuntime.resetLedgerCache();
  }
}

async function seedRunFromLedgerIfNeeded(input: {
  reuseCompleted: boolean;
  isResume: boolean;
  hadExistingState: boolean;
  tasks: TaskSpec[];
  state: RunState;
  stateStore: StateStore;
  repoPath: string;
  vcs: Vcs;
  orchLog: JsonlLogger;
  ledgerRuntime: LedgerRuntime;
}): Promise<void> {
  const shouldSeedFromLedger = input.reuseCompleted && (!input.hadExistingState || input.isResume);
  if (!shouldSeedFromLedger) return;

  const ledgerContext = await input.ledgerRuntime.ensureLedgerContext();
  const seedResult = await seedRunFromLedger({
    tasks: input.tasks,
    state: input.state,
    ledger: ledgerContext.ledger,
    repoPath: input.repoPath,
    headSha: ledgerContext.headSha,
    vcs: input.vcs,
    taskFileIndex: ledgerContext.taskFileIndex,
    eligibilityCache: input.ledgerRuntime.eligibilityCache,
    reachabilityCache: input.ledgerRuntime.reachabilityCache,
    fingerprintCache: input.ledgerRuntime.fingerprintCache,
  });

  for (const seeded of seedResult.seeded) {
    logOrchestratorEvent(input.orchLog, "task.seeded_complete", {
      task_id: seeded.taskId,
      merge_commit: seeded.entry.mergeCommit ?? null,
      ledger_run_id: seeded.entry.runId ?? null,
    });
  }

  if (seedResult.seeded.length > 0) {
    await input.stateStore.save(input.state);
  }
}

async function prepareLedgerRuntime(input: {
  projectName: string;
  repoPath: string;
  tasksRootAbs: string;
  runId: string;
  tasks: TaskSpec[];
  taskCatalog: TaskSpec[];
  state: RunState;
  stateStore: StateStore;
  paths: PathsContext;
  reuseCompleted: boolean;
  importRunId: string | null;
  isResume: boolean;
  hadExistingState: boolean;
  orchLog: JsonlLogger;
  vcs: Vcs;
}): Promise<LedgerRuntime> {
  const ledgerRuntime = createLedgerContextManager({
    projectName: input.projectName,
    repoPath: input.repoPath,
    tasksRootAbs: input.tasksRootAbs,
    taskCatalog: input.taskCatalog,
    paths: input.paths,
    vcs: input.vcs,
  });

  await importLedgerFromRunIfRequested({
    importRunId: input.importRunId,
    projectName: input.projectName,
    repoPath: input.repoPath,
    tasksRootAbs: input.tasksRootAbs,
    taskCatalog: input.taskCatalog,
    paths: input.paths,
    orchLog: input.orchLog,
  });

  await maybeImportLedgerFromArchiveRuns({
    reuseCompleted: input.reuseCompleted,
    importRunId: input.importRunId,
    tasks: input.tasks,
    taskCatalog: input.taskCatalog,
    projectName: input.projectName,
    repoPath: input.repoPath,
    tasksRootAbs: input.tasksRootAbs,
    paths: input.paths,
    orchLog: input.orchLog,
    ledgerRuntime,
  });

  await seedRunFromLedgerIfNeeded({
    reuseCompleted: input.reuseCompleted,
    isResume: input.isResume,
    hadExistingState: input.hadExistingState,
    tasks: input.tasks,
    state: input.state,
    stateStore: input.stateStore,
    repoPath: input.repoPath,
    vcs: input.vcs,
    orchLog: input.orchLog,
    ledgerRuntime,
  });

  return ledgerRuntime;
}

// =============================================================================
// RUN INIT HELPERS
// =============================================================================

type RunStateInitInput = {
  projectName: string;
  runId: string;
  repoPath: string;
  config: ProjectConfig;
  isResume: boolean;
  runResumeReason: string;
  controlPlaneConfig: ControlPlaneRunConfig;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  plannedBatches: BatchPlanEntry[];
  vcs: Vcs;
  closeValidationPipeline: () => void;
};

type RunStateInitResult =
  | {
      earlyResult: RunResult;
    }
  | {
      state: RunState;
      hadExistingState: boolean;
      controlPlaneSnapshot: ControlPlaneSnapshot | undefined;
      controlPlaneConfig: ControlPlaneRunConfig;
    };

type RunStateLoadResult =
  | {
      earlyResult: RunResult;
    }
  | {
      state: RunState | null;
      hadExistingState: boolean;
    };

async function loadRunStateForInit(input: RunStateInitInput): Promise<RunStateLoadResult> {
  const hadExistingState = await input.stateStore.exists();
  if (!hadExistingState) {
    if (input.isResume) {
      logOrchestratorEvent(input.orchLog, "run.resume.blocked", { reason: "state_missing" });
      input.orchLog.close();
      throw new Error(`Cannot resume run ${input.runId}: state file not found.`);
    }

    return { state: null, hadExistingState: false };
  }

  const state = await input.stateStore.load();
  const canResume = state.status === "running" || (input.isResume && state.status === "paused");
  if (!canResume) {
    logRunResume(input.orchLog, { status: state.status, reason: input.runResumeReason });
    logOrchestratorEvent(input.orchLog, "run.resume.blocked", { reason: "state_not_running" });
    input.closeValidationPipeline();
    input.orchLog.close();
    return {
      earlyResult: {
        runId: input.runId,
        state,
        plan: input.plannedBatches,
      },
    };
  }

  if (state.status === "paused" && input.isResume) {
    state.status = "running";
    await input.stateStore.save(state);
  }

  return { state, hadExistingState: true };
}

async function initializeRunStateAndSnapshot(
  input: RunStateInitInput,
): Promise<RunStateInitResult> {
  await input.vcs.ensureCleanWorkingTree(input.repoPath);
  await input.vcs.checkoutOrCreateBranch(input.repoPath, input.config.main_branch);

  const stateResult = await loadRunStateForInit(input);
  if ("earlyResult" in stateResult) return stateResult;

  const hadExistingState = stateResult.hadExistingState;
  let state = stateResult.state;
  let controlPlaneSnapshot: ControlPlaneSnapshot | undefined = state?.control_plane;
  const snapshotEnabled = controlPlaneSnapshot?.enabled ?? input.controlPlaneConfig.enabled;
  if (!controlPlaneSnapshot?.base_sha) {
    const baseSha = await input.vcs.resolveRunBaseSha(input.repoPath, input.config.main_branch);
    controlPlaneSnapshot = {
      enabled: snapshotEnabled,
      base_sha: baseSha,
    };

    if (hadExistingState && state) {
      state.control_plane = controlPlaneSnapshot;
      await input.stateStore.save(state);
    } else {
      state = createRunState({
        runId: input.runId,
        project: input.projectName,
        repoPath: input.repoPath,
        mainBranch: input.config.main_branch,
        taskIds: [],
        controlPlane: controlPlaneSnapshot,
      });
      await input.stateStore.save(state);
    }
  } else if (!hadExistingState) {
    state = createRunState({
      runId: input.runId,
      project: input.projectName,
      repoPath: input.repoPath,
      mainBranch: input.config.main_branch,
      taskIds: [],
      controlPlane: controlPlaneSnapshot,
    });
    await input.stateStore.save(state);
  }

  if (!state) {
    throw new Error(`Run state missing after initialization for ${input.runId}.`);
  }

  if (shouldBuildControlPlaneSnapshot(controlPlaneSnapshot)) {
    controlPlaneSnapshot = await buildControlPlaneSnapshot({
      repoPath: input.repoPath,
      baseSha: controlPlaneSnapshot.base_sha,
      enabled: true,
    });
    state.control_plane = controlPlaneSnapshot;
    await input.stateStore.save(state);
  }

  let controlPlaneConfig = input.controlPlaneConfig;
  if (controlPlaneSnapshot && controlPlaneSnapshot.enabled !== controlPlaneConfig.enabled) {
    controlPlaneConfig = {
      ...controlPlaneConfig,
      enabled: controlPlaneSnapshot.enabled,
    };
  }

  return {
    state,
    hadExistingState,
    controlPlaneSnapshot,
    controlPlaneConfig,
  };
}

type TaskLoadInput = {
  repoPath: string;
  config: ProjectConfig;
  options: RunOptions;
  knownResources: string[];
  orchLog: JsonlLogger;
  runId: string;
  state: RunState;
  plannedBatches: BatchPlanEntry[];
  closeValidationPipeline: () => void;
};

type TaskLoadResult =
  | {
      earlyResult: RunResult;
    }
  | {
      tasks: TaskSpec[];
      taskCatalog: TaskSpec[];
    };

async function loadTasksForRun(input: TaskLoadInput): Promise<TaskLoadResult> {
  let tasks: TaskSpec[];
  let taskCatalog: TaskSpec[];
  try {
    const res = await loadTaskSpecs(input.repoPath, input.config.tasks_dir, {
      knownResources: input.knownResources,
    });
    tasks = res.tasks;
    taskCatalog = res.tasks;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOrchestratorEvent(input.orchLog, "run.tasks_invalid", { message });
    input.closeValidationPipeline();
    input.orchLog.close();
    throw error;
  }

  if (input.options.tasks && input.options.tasks.length > 0) {
    const allow = new Set(input.options.tasks);
    tasks = tasks.filter((t) => allow.has(t.manifest.id));
  }

  if (tasks.length === 0) {
    logOrchestratorEvent(input.orchLog, "run.no_tasks");
    input.closeValidationPipeline();
    input.orchLog.close();
    return {
      earlyResult: {
        runId: input.runId,
        state: input.state,
        plan: input.plannedBatches,
      },
    };
  }

  return { tasks, taskCatalog };
}

// =============================================================================
// RUN LOOP
// =============================================================================

type RunLoopContext = {
  projectName: string;
  runId: string;
  options: RunOptions;
  repoPath: string;
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  vcs: Vcs;
  tasks: TaskSpec[];
  plannedBatches: BatchPlanEntry[];
  maxParallel: number;
  lockMode: ControlPlaneLockMode;
  lockResolver: LockResolver;
  reuseCompleted: boolean;
  taskEngine: ReturnType<typeof createTaskEngine>;
  batchEngine: ReturnType<typeof createBatchEngine>;
  buildStatusSets: (state: RunState) => { completed: Set<string>; failed: Set<string> };
  ensureLedgerContext: () => Promise<LedgerContext>;
  ledgerEligibilityCache: Map<string, LedgerEligibilityResult>;
  ledgerReachabilityCache: Map<string, boolean>;
  ledgerFingerprintCache: Map<string, string>;
  externalDepsLogged: Set<string>;
  stopIfRequested: () => Promise<RunResult | null>;
};

type RunLoopOutcome =
  | { type: "continue" }
  | { type: "break" }
  | { type: "stop"; result: RunResult };

async function executeRunLoop(input: RunLoopContext): Promise<RunResult | null> {
  const continueLoop = (): RunLoopOutcome => ({ type: "continue" });
  const breakLoop = (): RunLoopOutcome => ({ type: "break" });

  const findRunningBatch = (): (typeof input.state.batches)[number] | null => {
    const activeBatch = input.state.batches.find((b) => b.status === "running");
    if (activeBatch) return activeBatch;

    const runningTaskEntry = Object.entries(input.state.tasks).find(
      ([, t]) => t.status === "running",
    );
    if (!runningTaskEntry) return null;

    const batchId = input.state.tasks[runningTaskEntry[0]].batch_id;
    if (batchId === undefined) return null;

    return input.state.batches.find((b) => b.batch_id === batchId) ?? null;
  };

  const handleRunningBatch = async (
    runningBatch: (typeof input.state.batches)[number],
  ): Promise<RunLoopOutcome> => {
    const batchTasks = input.tasks.filter((t) => runningBatch.tasks.includes(t.manifest.id));
    if (batchTasks.length === 0) {
      input.state.status = "failed";
      await input.stateStore.save(input.state);
      logOrchestratorEvent(input.orchLog, "run.stop", {
        reason: "running_batch_missing_tasks",
      });
      return breakLoop();
    }

    const runningTasks = batchTasks.filter(
      (t) => input.state.tasks[t.manifest.id]?.status === "running",
    );
    const results = await Promise.all(
      runningTasks.map((task) => input.taskEngine.resumeRunningTask(task)),
    );
    const stopReason = await input.batchEngine.finalizeBatch({
      batchId: runningBatch.batch_id,
      batchTasks,
      results,
    });

    if (stopReason) {
      logOrchestratorEvent(input.orchLog, "run.stop", { reason: stopReason });
      return breakLoop();
    }

    return continueLoop();
  };

  const handlePendingTasks = async (pendingTasks: TaskSpec[]): Promise<RunLoopOutcome> => {
    const completed = input.buildStatusSets(input.state).completed;
    const externalCompletedDeps = await resolveExternalDepsForPending({
      pendingTasks,
      reuseCompleted: input.reuseCompleted,
      ensureLedgerContext: input.ensureLedgerContext,
      state: input.state,
      repoPath: input.repoPath,
      vcs: input.vcs,
      orchLog: input.orchLog,
      externalDepsLogged: input.externalDepsLogged,
      eligibilityCache: input.ledgerEligibilityCache,
      reachabilityCache: input.ledgerReachabilityCache,
      fingerprintCache: input.ledgerFingerprintCache,
    });

    const effectiveCompleted = new Set([...completed, ...externalCompletedDeps]);
    const ready = topologicalReady(pendingTasks, effectiveCompleted);
    if (ready.length === 0) {
      return await handleNoReadyTasks({
        pendingTasks,
        state: input.state,
        stateStore: input.stateStore,
        orchLog: input.orchLog,
        projectName: input.projectName,
        runId: input.runId,
        completed: effectiveCompleted,
      });
    }

    return await handleReadyBatch({
      ready,
      maxParallel: input.maxParallel,
      lockResolver: input.lockResolver,
      lockMode: input.lockMode,
      options: input.options,
      state: input.state,
      stateStore: input.stateStore,
      orchLog: input.orchLog,
      plannedBatches: input.plannedBatches,
      taskEngine: input.taskEngine,
      batchEngine: input.batchEngine,
    });
  };

  while (true) {
    const stopResult = await input.stopIfRequested();
    if (stopResult) return stopResult;

    const runningBatch = findRunningBatch();
    if (runningBatch) {
      const outcome = await handleRunningBatch(runningBatch);
      if (outcome.type === "stop") return outcome.result;
      if (outcome.type === "break") break;
      continue;
    }

    const pendingTasks = input.tasks.filter(
      (t) => input.state.tasks[t.manifest.id]?.status === "pending",
    );
    if (pendingTasks.length === 0) break;

    const outcome = await handlePendingTasks(pendingTasks);
    if (outcome.type === "stop") return outcome.result;
    if (outcome.type === "break") break;
  }

  return null;
}

async function resolveExternalDepsForPending(input: {
  pendingTasks: TaskSpec[];
  reuseCompleted: boolean;
  ensureLedgerContext: () => Promise<LedgerContext>;
  state: RunState;
  repoPath: string;
  vcs: Vcs;
  orchLog: JsonlLogger;
  externalDepsLogged: Set<string>;
  eligibilityCache: Map<string, LedgerEligibilityResult>;
  reachabilityCache: Map<string, boolean>;
  fingerprintCache: Map<string, string>;
}): Promise<Set<string>> {
  if (!input.reuseCompleted) {
    return new Set<string>();
  }

  const ledgerContext = await input.ensureLedgerContext();
  const externalDeps = await resolveExternalCompletedDeps({
    pendingTasks: input.pendingTasks,
    state: input.state,
    ledger: ledgerContext.ledger,
    repoPath: input.repoPath,
    headSha: ledgerContext.headSha,
    vcs: input.vcs,
    taskFileIndex: ledgerContext.taskFileIndex,
    eligibilityCache: input.eligibilityCache,
    reachabilityCache: input.reachabilityCache,
    fingerprintCache: input.fingerprintCache,
  });

  for (const [taskId, deps] of externalDeps.satisfiedByTask.entries()) {
    if (input.externalDepsLogged.has(taskId)) continue;
    input.externalDepsLogged.add(taskId);
    logOrchestratorEvent(input.orchLog, "deps.external_satisfied", {
      task_id: taskId,
      deps: deps.map((dep) => ({
        dep_id: dep.depId,
        merge_commit: dep.mergeCommit ?? null,
        ledger_run_id: dep.runId ?? null,
        completed_at: dep.completedAt ?? null,
      })),
    });
  }

  return externalDeps.externalCompleted;
}

async function handleNoReadyTasks(input: {
  pendingTasks: TaskSpec[];
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  projectName: string;
  runId: string;
  completed: Set<string>;
}): Promise<RunLoopOutcome> {
  const dependencyIssues = collectDependencyIssues(
    input.pendingTasks,
    input.state,
    input.completed,
  );
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

    logOrchestratorEvent(input.orchLog, "run.paused", {
      reason: "blocked_dependencies",
      message:
        "No dependency-satisfied tasks remain; pending tasks are blocked by tasks requiring attention.",
      pending_task_count: input.pendingTasks.length,
      blocked_task_count: blockedTasksPayload.length,
      blocked_tasks: blockedTasksPayload,
      resume_command: `mycelium resume --project ${input.projectName} --run-id ${input.runId}`,
    });
    input.state.status = "paused";
    await input.stateStore.save(input.state);
    return { type: "break" };
  }

  if (dependencyIssues.missing.length > 0) {
    const missingPayload = dependencyIssues.missing.map((entry) => ({
      task_id: entry.taskId,
      missing_deps: entry.missingDeps,
    }));
    logOrchestratorEvent(input.orchLog, "run.blocked", {
      reason: "missing_dependencies",
      message: "No dependency-satisfied tasks remain; some dependencies are missing from this run.",
      pending_task_count: input.pendingTasks.length,
      blocked_task_count: missingPayload.length,
      blocked_tasks: missingPayload,
    });
    input.state.status = "failed";
    await input.stateStore.save(input.state);
    return { type: "break" };
  }

  const pendingPayload = dependencyIssues.pending.map((entry) => ({
    task_id: entry.taskId,
    pending_deps: entry.pendingDeps,
  }));
  logOrchestratorEvent(input.orchLog, "run.blocked", {
    reason: "true_deadlock",
    message:
      "No dependency-satisfied tasks remain; pending tasks depend on each other or unresolved tasks.",
    pending_task_count: input.pendingTasks.length,
    blocked_task_count: pendingPayload.length,
    blocked_tasks: pendingPayload,
  });
  input.state.status = "failed";
  await input.stateStore.save(input.state);
  return { type: "break" };
}

async function handleReadyBatch(input: {
  ready: TaskSpec[];
  maxParallel: number;
  lockResolver: LockResolver;
  lockMode: ControlPlaneLockMode;
  options: RunOptions;
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  plannedBatches: BatchPlanEntry[];
  taskEngine: ReturnType<typeof createTaskEngine>;
  batchEngine: ReturnType<typeof createBatchEngine>;
}): Promise<RunLoopOutcome> {
  let batchId = Math.max(0, ...input.state.batches.map((b) => b.batch_id));
  batchId += 1;
  const { batch } = buildGreedyBatch(input.ready, input.maxParallel, input.lockResolver);

  const batchTaskIds = batch.tasks.map((task) => task.manifest.id);
  input.plannedBatches.push({ batchId, taskIds: batchTaskIds, locks: batch.locks });
  const startedAt = isoNow();
  startBatch(input.state, { batchId, taskIds: batchTaskIds, locks: batch.locks, now: startedAt });
  await input.stateStore.save(input.state);

  logOrchestratorEvent(input.orchLog, "batch.start", {
    batch_id: batchId,
    tasks: batchTaskIds,
    locks: batch.locks,
    lock_mode: input.lockMode,
  });

  if (input.options.dryRun) {
    logOrchestratorEvent(input.orchLog, "batch.dry_run", {
      batch_id: batchId,
      tasks: batchTaskIds,
    });
    for (const task of batch.tasks) {
      input.state.tasks[task.manifest.id].status = "skipped";
      input.state.tasks[task.manifest.id].completed_at = isoNow();
    }
    input.state.batches[input.state.batches.length - 1].status = "complete";
    input.state.batches[input.state.batches.length - 1].completed_at = isoNow();
    await input.stateStore.save(input.state);
    return { type: "continue" };
  }

  const results = await Promise.all(
    batch.tasks.map((task) => input.taskEngine.runTaskAttempt(task)),
  );

  const stopReason = await input.batchEngine.finalizeBatch({
    batchId,
    batchTasks: batch.tasks,
    results,
  });

  if (stopReason) {
    logOrchestratorEvent(input.orchLog, "run.stop", { reason: stopReason });
    return { type: "break" };
  }

  return { type: "continue" };
}

type RunFinalizationInput = {
  projectName: string;
  runId: string;
  repoPath: string;
  state: RunState;
  stateStore: StateStore;
  orchLog: JsonlLogger;
  plannedBatches: BatchPlanEntry[];
  lockMode: ControlPlaneLockMode;
  scopeComplianceMode: ControlPlaneScopeMode;
  controlPlaneEnabled: boolean;
  runMetrics: RunMetrics;
  stopIfRequested: () => Promise<RunResult | null>;
  closeValidationPipeline: () => void;
};

async function finalizeRun(input: RunFinalizationInput): Promise<RunResult> {
  const stopAfterLoop = await input.stopIfRequested();
  if (stopAfterLoop) return stopAfterLoop;

  if (input.state.status === "running") {
    const blockedTasks = summarizeBlockedTasks(input.state.tasks);
    if (blockedTasks.length > 0) {
      const blockedTasksPayload = blockedTasks.map((task) => ({
        task_id: task.taskId,
        status: task.status,
        ...(task.lastError ? { last_error: task.lastError } : {}),
      }));
      input.state.status = "paused";
      logOrchestratorEvent(input.orchLog, "run.paused", {
        reason: "blocked_tasks",
        message: "Run paused with tasks requiring attention.",
        blocked_task_count: blockedTasksPayload.length,
        blocked_tasks: blockedTasksPayload,
        resume_command: `mycelium resume --project ${input.projectName} --run-id ${input.runId}`,
      });
    } else {
      input.state.status = "complete";
    }
  }
  await input.stateStore.save(input.state);

  const runSummary = buildRunSummary({
    runId: input.runId,
    projectName: input.projectName,
    state: input.state,
    lockMode: input.lockMode,
    scopeMode: input.scopeComplianceMode,
    controlPlaneEnabled: input.controlPlaneEnabled,
    metrics: input.runMetrics,
  });
  const runSummaryPath = runSummaryReportPath(input.repoPath, input.runId);
  try {
    await writeJsonFile(runSummaryPath, runSummary);
    logOrchestratorEvent(input.orchLog, "run.summary", {
      status: input.state.status,
      report_path: runSummaryPath,
      metrics: runSummary.metrics,
    });
  } catch (error) {
    logOrchestratorEvent(input.orchLog, "run.summary.error", {
      status: input.state.status,
      report_path: runSummaryPath,
      message: formatErrorMessage(error),
    });
  }

  logOrchestratorEvent(input.orchLog, "run.complete", { status: input.state.status });
  input.closeValidationPipeline();
  input.orchLog.close();

  return { runId: input.runId, state: input.state, plan: input.plannedBatches };
}

// =============================================================================
// RUN STOP TYPES
// =============================================================================

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

type RunHeartbeat = {
  stop: () => void;
};

// =============================================================================
// CONTROL PLANE SNAPSHOT
// =============================================================================

function resolveEffectiveLockMode(config: ControlPlaneRunConfig): ControlPlaneLockMode {
  return config.enabled ? config.lockMode : "declared";
}

export function resolveScopeComplianceMode(config: ControlPlaneRunConfig): ControlPlaneScopeMode {
  return config.scopeMode;
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

// =============================================================================
// RESOURCE RESOLUTION
// =============================================================================

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
  if (!input.controlPlaneConfig.enabled) {
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

// =============================================================================
// RUN METRICS
// =============================================================================

export type RunMetrics = {
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
  const totalBatchTasks = input.state.batches.reduce((sum, batch) => sum + batch.tasks.length, 0);
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

// =============================================================================
// STOP CONTROLLER
// =============================================================================

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
// RUN HEARTBEAT
// =============================================================================

function startRunHeartbeat(input: {
  state: RunState;
  stateStore: StateStore;
  orchestratorLog: JsonlLogger;
  intervalMs: number;
}): RunHeartbeat {
  let stopped = false;
  let errorLogged = false;

  const tick = (): void => {
    if (stopped) return;
    if (input.state.status !== "running") return;

    void input.stateStore.save(input.state).catch((err) => {
      if (errorLogged) return;
      errorLogged = true;
      logOrchestratorEvent(input.orchestratorLog, "run.heartbeat.error", {
        message: formatErrorMessage(err),
      });
    });
  };

  const handle = setInterval(tick, input.intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

// =============================================================================
// LEDGER REUSE HELPERS
// =============================================================================

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

type ArchiveImportSummary = {
  runIds: string[];
  imported: string[];
  skipped: string[];
  skippedRuns: { runId: string; reason: string }[];
};

function collectExternalDependencies(tasks: TaskSpec[]): Set<string> {
  const taskIds = new Set(tasks.map((task) => task.manifest.id));
  const externalDeps = new Set<string>();

  for (const task of tasks) {
    const deps = task.manifest.dependencies ?? [];
    for (const depId of deps) {
      if (!taskIds.has(depId)) {
        externalDeps.add(depId);
      }
    }
  }

  return externalDeps;
}

async function listArchiveRunIds(tasksRoot: string): Promise<string[]> {
  const archiveDir = resolveTasksArchiveDir(tasksRoot);
  const entries = await fs.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

async function autoImportLedgerFromArchiveRuns(args: {
  projectName: string;
  repoPath: string;
  tasksRoot: string;
  tasks: TaskSpec[];
  paths: PathsContext;
}): Promise<ArchiveImportSummary> {
  const runIds = await listArchiveRunIds(args.tasksRoot);
  const imported: string[] = [];
  const skipped: string[] = [];
  const skippedRuns: { runId: string; reason: string }[] = [];

  for (const runId of runIds) {
    const store = new StateStore(args.projectName, runId, args.paths);
    if (!(await store.exists())) {
      skippedRuns.push({ runId, reason: "run state not found" });
      continue;
    }

    const state = await store.load();
    const result = await importLedgerFromRunState({
      projectName: args.projectName,
      repoPath: args.repoPath,
      runId,
      tasks: args.tasks,
      state,
      tasksRoot: args.tasksRoot,
      paths: args.paths,
    });
    imported.push(...result.imported);
    skipped.push(...result.skipped);
  }

  return { runIds, imported, skipped, skippedRuns };
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
  vcs: Vcs;
  reachabilityCache: Map<string, boolean>;
}): Promise<boolean> {
  const cached = args.reachabilityCache.get(args.mergeCommit);
  if (cached !== undefined) return cached;

  const reachable = await args.vcs.isAncestor(args.repoPath, args.mergeCommit, args.headSha);
  args.reachabilityCache.set(args.mergeCommit, reachable);
  return reachable;
}

async function resolveLedgerEligibility(args: {
  taskId: string;
  ledger: TaskLedger | null;
  repoPath: string;
  headSha: string;
  vcs: Vcs;
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
    vcs: args.vcs,
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
  vcs: Vcs;
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
      vcs: args.vcs,
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
  vcs: Vcs;
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
        vcs: args.vcs,
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
      .filter(
        ([, s]) => s.status === "complete" || s.status === "validated" || s.status === "skipped",
      )
      .map(([id]) => id),
  );
  const failed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => isBlockedTaskStatus(s.status))
      .map(([id]) => id),
  );
  return { completed, failed };
}

// =============================================================================
// WORKER RUNNER
// =============================================================================

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
