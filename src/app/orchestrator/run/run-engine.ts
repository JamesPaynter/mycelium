/**
 * RunEngine orchestrates a run by delegating task + batch execution.
 * Purpose: centralize run control-flow behind RunContext.
 * Assumptions: run engine owns run state + store, passed in via context.
 * Usage: runEngine(context) from executor.
 */

import fs from "node:fs/promises";
import path from "node:path";

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

export { shouldResetTaskToPending } from "./failure-policy.js";

import { buildControlPlaneModel } from "../../../control-plane/model/build.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import { ControlPlaneStore } from "../../../control-plane/storage.js";
import {
  createComponentOwnerResolver,
  createComponentOwnershipResolver,
  deriveComponentResources,
} from "../../../control-plane/integration/resources.js";
import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../../../control-plane/integration/derived-scope.js";
import type { PolicyDecision } from "../../../control-plane/policy/types.js";
import type {
  ControlPlaneLockMode,
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
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
import { loadTaskSpecs } from "../../../core/task-loader.js";
import { normalizeLocks, type TaskSpec } from "../../../core/task-manifest.js";
import { buildTaskFileIndex, type TaskFileLocation } from "../../../core/task-file-index.js";
import { resolveTasksArchiveDir } from "../../../core/task-layout.js";
import {
  computeTaskFingerprint,
  importLedgerFromRunState,
  loadTaskLedger,
  type TaskLedger,
  type TaskLedgerEntry,
} from "../../../core/task-ledger.js";
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
import { ensureDir, isoNow, readJsonFile, writeJsonFile } from "../../../core/utils.js";
import type { ContainerSpec } from "../../../docker/docker.js";

import { createBatchEngine } from "./batch-engine.js";
import { createTaskEngine } from "./task-engine.js";

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

  try {
    const {
      projectName,
      config,
      options,
      ports: { vcs },
      resolved: {
        run: { runId, isResume, reuseCompleted, importRunId, maxParallel },
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
    let stopRequested: StopRequest | null = null;
    let state!: RunState;

    // Prepare directories
    await ensureDir(orchestratorHome(pathsContext));
    const stateStore = new StateStore(projectName, runId, pathsContext);
    const orchLog = new JsonlLogger(orchestratorLogPath(projectName, runId, pathsContext), {
      runId,
    });
    let validationPipeline: ValidationPipeline | null = null;
    const closeValidationPipeline = (): void => {
      validationPipeline?.close();
    };

    logOrchestratorEvent(orchLog, "run.start", {
      project: projectName,
      repo_path: repoPath,
    });

    // Ensure repo is clean and on integration branch.
    await vcs.ensureCleanWorkingTree(repoPath);
    await vcs.checkoutOrCreateBranch(repoPath, config.main_branch);

    const runResumeReason = isResume ? "resume_command" : "existing_state";
    const hadExistingState = await stateStore.exists();
    if (hadExistingState) {
      state = await stateStore.load();

      const canResume = state.status === "running" || (isResume && state.status === "paused");
      if (!canResume) {
        logRunResume(orchLog, { status: state.status, reason: runResumeReason });
        logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_not_running" });
        closeValidationPipeline();
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
      const baseSha = await vcs.resolveRunBaseSha(repoPath, config.main_branch);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOrchestratorEvent(orchLog, "run.tasks_invalid", { message });
      closeValidationPipeline();
      orchLog.close();
      throw error;
    }
    if (options.tasks && options.tasks.length > 0) {
      const allow = new Set(options.tasks);
      tasks = tasks.filter((t) => allow.has(t.manifest.id));
    }

    if (tasks.length === 0) {
      logOrchestratorEvent(orchLog, "run.no_tasks");
      closeValidationPipeline();
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

    validationPipeline = new ValidationPipeline({
      projectName,
      repoPath,
      runId,
      tasksRoot: tasksRootAbs,
      mainBranch: config.main_branch,
      paths: pathsContext,
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
      runner: context.ports.validatorRunner,
      onChecksetDuration: (durationMs) => {
        recordChecksetDuration(runMetrics, durationMs);
      },
      onDoctorDuration: (durationMs) => {
        recordDoctorDuration(runMetrics, durationMs);
      },
    });
    const compliancePipeline = new CompliancePipeline({
      projectName,
      runId,
      tasksRoot: tasksRootAbs,
      mainBranch: config.main_branch,
      resourceContext: {
        resources: resourceContext.effectiveResources,
        staticResources: resourceContext.staticResources,
        fallbackResource: resourceContext.fallbackResource,
        ownerResolver: resourceContext.ownerResolver,
        ownershipResolver: resourceContext.ownershipResolver,
        resourcesMode: resourceContext.resourcesMode,
      },
      orchestratorLog: orchLog,
      paths: pathsContext,
    });
    const budgetTracker = new BudgetTracker({
      projectName,
      runId,
      costPer1kTokens,
      budgets: config.budgets,
      orchestratorLog: orchLog,
      paths: pathsContext,
    });

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

    // Create or resume run state
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
      const usageBackfilled = budgetTracker.backfillUsageFromLogs({ tasks, state });
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
        ledgerSnapshot = await loadTaskLedger(projectName, pathsContext);
        ledgerLoaded = true;
      }
      if (!ledgerHeadSha) {
        ledgerHeadSha = await vcs.headSha(repoPath);
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
      const importStore = new StateStore(projectName, importRunId, pathsContext);
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
        paths: pathsContext,
      });
      logOrchestratorEvent(orchLog, "ledger.import.complete", {
        run_id: importRunId,
        imported: importResult.imported,
        skipped: importResult.skipped,
      });
    }

    const externalDeps = collectExternalDependencies(tasks);
    if (reuseCompleted && !importRunId && externalDeps.size > 0) {
      const ledgerContext = await ensureLedgerContext();
      const ledgerTasks = ledgerContext.ledger?.tasks ?? {};
      const missingFromLedger = [...externalDeps].filter((depId) => !ledgerTasks[depId]);

      if (missingFromLedger.length > 0) {
        const archiveImport = await autoImportLedgerFromArchiveRuns({
          projectName,
          repoPath,
          tasksRoot: tasksRootAbs,
          tasks: taskCatalog,
          paths: pathsContext,
        });

        if (archiveImport.runIds.length > 0) {
          logOrchestratorEvent(orchLog, "ledger.import.archive", {
            run_count: archiveImport.runIds.length,
            imported: archiveImport.imported.length,
            skipped: archiveImport.skipped.length,
            skipped_runs: archiveImport.skippedRuns.length,
          });
        }

        if (archiveImport.imported.length > 0) {
          ledgerLoaded = false;
          ledgerSnapshot = null;
        }
      }
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
        vcs,
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
      closeValidationPipeline();
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

    const taskEngine = createTaskEngine({
      projectName,
      runId,
      config,
      state,
      stateStore,
      tasksRootAbs,
      repoPath,
      paths: pathsContext,
      workerRunner,
      vcs,
      orchestratorLog: orchLog,
      mockLlmMode,
      crashAfterContainerStart,
      controlPlaneConfig,
      derivedScopeReports,
      blastContext,
      policyDecisions,
    });

    const batchEngine = createBatchEngine(
      {
        projectName,
        runId,
        repoPath,
        tasksRootAbs,
        paths: pathsContext,
        config,
        state,
        stateStore,
        orchestratorLog: orchLog,
        taskEngine,
        validationPipeline,
        compliancePipeline,
        budgetTracker,
        runMetrics,
        recordDoctorDuration: (durationMs) => {
          recordDoctorDuration(runMetrics, durationMs);
        },
        controlPlaneConfig,
        scopeComplianceMode,
        manifestPolicy,
        policyDecisions,
        blastContext,
        doctorValidatorConfig,
        doctorValidatorEnabled,
        doctorCanaryConfig,
        cleanupWorkspacesOnSuccess,
        cleanupContainersOnSuccess,
        workerRunner,
        shouldSkipCleanup: () => stopRequested !== null || stopController.reason !== null,
        vcs,
        buildStatusSets,
      },
      { doctorValidatorLastCount: completed.size + failed.size },
    );

    const findRunningBatch = (): (typeof state.batches)[number] | null => {
      const activeBatch = state.batches.find((b) => b.status === "running");
      if (activeBatch) return activeBatch;

      const runningTaskEntry = Object.entries(state.tasks).find(([, t]) => t.status === "running");
      if (!runningTaskEntry) return null;

      const batchId = state.tasks[runningTaskEntry[0]].batch_id;
      if (batchId === undefined) return null;

      return state.batches.find((b) => b.batch_id === batchId) ?? null;
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
          logOrchestratorEvent(orchLog, "run.stop", {
            reason: "running_batch_missing_tasks",
          });
          break;
        }

        const runningTasks = batchTasks.filter(
          (t) => state.tasks[t.manifest.id]?.status === "running",
        );
        const results = await Promise.all(
          runningTasks.map((task) => taskEngine.resumeRunningTask(task)),
        );
        const stopReason = await batchEngine.finalizeBatch({
          batchId: runningBatch.batch_id,
          batchTasks,
          results,
        });

        ({ completed, failed } = buildStatusSets(state));

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
          vcs,
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

      if (options.dryRun) {
        logOrchestratorEvent(orchLog, "batch.dry_run", {
          batch_id: batchId,
          tasks: batchTaskIds,
        });
        // Mark all as skipped for dry-run
        for (const t of batch.tasks) {
          state.tasks[t.manifest.id].status = "skipped";
          state.tasks[t.manifest.id].completed_at = isoNow();
          completed.add(t.manifest.id);
        }
        state.batches[state.batches.length - 1].status = "complete";
        state.batches[state.batches.length - 1].completed_at = isoNow();
        await stateStore.save(state);
        ({ completed, failed } = buildStatusSets(state));
        continue;
      }

      // Launch tasks in parallel.
      const results = await Promise.all(batch.tasks.map((task) => taskEngine.runTaskAttempt(task)));

      const stopReason = await batchEngine.finalizeBatch({
        batchId,
        batchTasks: batch.tasks,
        results,
      });

      ({ completed, failed } = buildStatusSets(state));

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
    closeValidationPipeline();
    orchLog.close();

    return { runId, state, plan: plannedBatches };
  } finally {
    stopController.cleanup();
  }
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
