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
} from "../docker/docker.js";
import { buildWorkerImage } from "../docker/image.js";
import { streamContainerLogs, type LogStreamHandle } from "../docker/streams.js";
import { ensureCleanWorkingTree, checkout } from "../git/git.js";
import { mergeTaskBranches } from "../git/merge.js";
import { buildTaskBranchName } from "../git/branches.js";
import { ensureCodexAuthForHome } from "./codexAuth.js";

import type {
  DoctorValidatorConfig,
  ManifestEnforcementPolicy,
  ProjectConfig,
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
import type { TaskSpec } from "./task-manifest.js";
import {
  orchestratorHome,
  orchestratorLogPath,
  taskEventsLogPath,
  taskComplianceReportPath,
  taskLogsDir,
  taskWorkspaceDir,
  workerCodexHomeDir,
  validatorsLogsDir,
  validatorLogPath,
  validatorReportPath,
  runLogsDir,
} from "./paths.js";
import { buildGreedyBatch, topologicalReady, type BatchPlan } from "./scheduler.js";
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
  type RunState,
  type ValidatorResult,
  type ValidatorStatus,
} from "./state.js";
import { ensureDir, defaultRunId, isoNow, writeJsonFile } from "./utils.js";
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
import { runManifestCompliance, type ManifestComplianceResult } from "./manifest-compliance.js";
import { computeRescopeFromCompliance } from "./manifest-rescope.js";

export type RunOptions = {
  runId?: string;
  resume?: boolean;
  tasks?: string[]; // limit to IDs
  maxParallel?: number;
  dryRun?: boolean;
  buildImage?: boolean;
  cleanupOnSuccess?: boolean;
  useDocker?: boolean;
};

export type BatchPlanEntry = {
  batchId: number;
  taskIds: string[];
  locks: BatchPlan["locks"];
};

export type RunResult = { runId: string; state: RunState; plan: BatchPlanEntry[] };

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

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<RunResult> {
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
  const plannedBatches: BatchPlanEntry[] = [];

  const repoPath = config.repo_path;
  const workerImage = config.docker.image;
  const docker = useDocker ? dockerClient() : null;
  const manifestPolicy: ManifestEnforcementPolicy = config.manifest_enforcement ?? "warn";
  const costPer1kTokens = DEFAULT_COST_PER_1K_TOKENS;

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
    await execa("git", ["checkout", "-b", config.main_branch], { cwd: repoPath, stdio: "pipe" });
  });

  // Load tasks.
  let tasks: TaskSpec[];
  try {
    const res = await loadTaskSpecs(repoPath, config.tasks_dir, {
      knownResources: config.resources.map((r) => r.name),
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
      state: createRunState({
        runId,
        project: projectName,
        repoPath,
        mainBranch: config.main_branch,
        taskIds: [],
      }),
      plan: plannedBatches,
    };
  }

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
    const haveImage = docker ? await imageExists(docker, workerImage) : false;
    if (!haveImage) {
      if (opts.buildImage ?? true) {
        logOrchestratorEvent(orchLog, "docker.image.build.start", { image: workerImage });
        await buildWorkerImage({
          tag: workerImage,
          dockerfile: config.docker.dockerfile,
          context: config.docker.build_context,
        });
        logOrchestratorEvent(orchLog, "docker.image.build.complete", { image: workerImage });
      } else {
        throw new Error(
          `Docker image not found: ${workerImage}. Build it or run with --build-image.`,
        );
      }
    }
  }

  // Create or resume run state
  let state: RunState;
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
  const stateExists = await stateStore.exists();
  if (stateExists) {
    state = await stateStore.load();

    const runResumeReason = isResume ? "resume_command" : "existing_state";
    if (state.status !== "running") {
      logRunResume(orchLog, { status: state.status, reason: runResumeReason });
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_not_running" });
      closeValidatorLogs();
      orchLog.close();
      return { runId, state, plan: plannedBatches };
    }

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
  } else {
    if (isResume) {
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_missing" });
      orchLog.close();
      throw new Error(`Cannot resume run ${runId}: state file not found.`);
    }

    state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: tasks.map((t) => t.manifest.id),
    });
    await stateStore.save(state);
  }

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

    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [
          `task-orchestrator.project=${projectName}`,
          `task-orchestrator.run_id=${runId}`,
        ],
      },
    });

    const byTask = containers.find((c) => c.Labels?.["task-orchestrator.task_id"] === taskId);
    if (byTask) {
      return { id: byTask.Id, name: firstContainerName(byTask.Names) };
    }

    if (containerIdHint) {
      const byId = containers.find(
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
          await logStream.completed.catch(() => undefined);
          logStream.detach();
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
    reportPath: string;
    result: ManifestComplianceResult;
  }): void {
    const basePayload = {
      task_slug: args.taskSlug,
      policy: args.policy,
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

      const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);
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
      const compliance = await runManifestCompliance({
        workspacePath: r.workspace,
        mainBranch: config.main_branch,
        manifest: taskSpec.manifest,
        resources: config.resources,
        policy: manifestPolicy,
        reportPath: complianceReportPath,
      });

      logComplianceEvents({
        taskId: r.taskId,
        taskSlug: r.taskSlug,
        policy: manifestPolicy,
        reportPath: complianceReportPath,
        result: compliance,
      });

      if (compliance.violations.length > 0) {
        const violationSummary = describeManifestViolations(compliance);
        const rescopeReason = `Rescope required: ${violationSummary}`;
        markTaskRescopeRequired(state, r.taskId, rescopeReason);
        logOrchestratorEvent(orchLog, "task.rescope.start", {
          taskId: r.taskId,
          violations: compliance.violations.length,
          report_path: complianceReportPath,
          policy: manifestPolicy,
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
        const doctorRes = await execaCommand(config.doctor, {
          cwd: repoPath,
          shell: true,
          reject: false,
          timeout: config.doctor_timeout ? config.doctor_timeout * 1000 : undefined,
        });
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
          doctorCanaryResult = await runDoctorCanary({
            command: config.doctor,
            cwd: repoPath,
            timeoutSeconds: config.doctor_timeout,
          });
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
    const { batch } = buildGreedyBatch(ready, maxParallel);

    const batchTaskIds = batch.tasks.map((t) => t.manifest.id);
    plannedBatches.push({ batchId, taskIds: batchTaskIds, locks: batch.locks });
    const startedAt = isoNow();
    startBatch(state, { batchId, taskIds: batchTaskIds, locks: batch.locks, now: startedAt });
    await stateStore.save(state);

    logOrchestratorEvent(orchLog, "batch.start", {
      batch_id: batchId,
      tasks: batchTaskIds,
      locks: batch.locks,
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

        const workspace = taskWorkspaceDir(projectName, runId, taskId);
        const tLogsDir = taskLogsDir(projectName, runId, taskId, taskSlug);
        const codexHome = workerCodexHomeDir(projectName, runId, taskId, taskSlug);

        await ensureDir(tLogsDir);
        await ensureDir(codexHome);
        await writeCodexConfig(path.join(codexHome, "config.toml"), {
          model: config.worker.model,
          // "never" means no approval prompts (unattended runs). See Codex config reference.
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        });
        // If the user authenticated via `codex login`, auth material typically lives under
        // ~/.codex/auth.json (file-based storage). Because we run each worker with a custom
        // CODEX_HOME, we copy that auth file into this per-task CODEX_HOME when no API key is provided.
        const auth = await ensureCodexAuthForHome(codexHome);
        logOrchestratorEvent(orchLog, "codex.auth", {
          taskId,
          mode: auth.mode,
          source: auth.mode === "env" ? auth.var : "auth.json",
        });

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

          const codexHomeInContainer = path.posix.join(
            "/workspace",
            ".task-orchestrator",
            "codex-home",
          );

          const container = await createContainer(docker, {
            name: containerName,
            image: workerImage,
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
                config.tasks_dir,
                path.basename(task.taskDir),
                "manifest.json",
              ),
              TASK_SPEC_PATH: path.posix.join(
                "/workspace",
                config.tasks_dir,
                path.basename(task.taskDir),
                "spec.md",
              ),
              TASK_BRANCH: branchName,
              DOCTOR_CMD: task.manifest.verify?.doctor ?? config.doctor,
              DOCTOR_TIMEOUT: config.doctor_timeout ? String(config.doctor_timeout) : undefined,
              MAX_RETRIES: String(config.max_retries),
              CHECKPOINT_COMMITS: config.worker.checkpoint_commits ? "true" : "false",
              DEFAULT_TEST_PATHS: JSON.stringify(config.test_paths ?? []),
              BOOTSTRAP_CMDS:
                config.bootstrap.length > 0 ? JSON.stringify(config.bootstrap) : undefined,
              CODEX_MODEL: config.worker.model,
              CODEX_HOME: codexHomeInContainer,
              RUN_LOGS_DIR: "/run-logs",
            },
            binds: [
              { hostPath: workspace, containerPath: "/workspace", mode: "rw" },
              { hostPath: tLogsDir, containerPath: "/run-logs", mode: "rw" },
            ],
            workdir: "/workspace",
            labels: {
              "task-orchestrator.project": projectName,
              "task-orchestrator.run_id": runId,
              "task-orchestrator.task_id": taskId,
              "task-orchestrator.branch": branchName,
              "task-orchestrator.workspace_path": workspace,
            },
          });

          const containerInfo = await container.inspect();
          const containerId = containerInfo.Id;
          state.tasks[taskId].container_id = containerId;
          await stateStore.save(state);

          logOrchestratorEvent(orchLog, "container.create", {
            taskId,
            container_id: containerId,
            name: containerName,
          });

          // Attach log stream
          const logStream = await streamContainerLogs(container, taskEvents, {
            fallbackType: "task.log",
          });

          try {
            await startContainer(container);
            logOrchestratorEvent(orchLog, "container.start", { taskId, container_id: containerId });

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
            await logStream.completed.catch(() => undefined);
            logStream.detach();
            taskEvents.close();
          }
        }

        logOrchestratorEvent(orchLog, "worker.local.start", { taskId, workspace });
        const manifestPath = path.join(
          workspace,
          config.tasks_dir,
          path.basename(task.taskDir),
          "manifest.json",
        );
        const specPath = path.join(
          workspace,
          config.tasks_dir,
          path.basename(task.taskDir),
          "spec.md",
        );
        const workerLogger = createLocalWorkerLogger(taskEvents, { taskId, taskSlug });

        try {
          await runWorker(
            {
              taskId,
              taskSlug,
              taskBranch: branchName,
              manifestPath,
              specPath,
              doctorCmd: task.manifest.verify?.doctor ?? config.doctor,
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

  if (state.status === "running") {
    state.status = failed.size > 0 ? "failed" : "complete";
  }
  await stateStore.save(state);

  logOrchestratorEvent(orchLog, "run.complete", { status: state.status });
  closeValidatorLogs();
  orchLog.close();

  // Optional cleanup of successful workspaces can be added later.
  return { runId, state, plan: plannedBatches };
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
    `approval_policy = "${opts.approvalPolicy}"`,
    `sandbox_mode = "${opts.sandboxMode}"`,
    "",
  ].join("\n");
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
