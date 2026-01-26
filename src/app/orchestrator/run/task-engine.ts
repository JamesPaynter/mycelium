/**
 * TaskEngine handles per-task orchestration logic.
 * Purpose: run or resume tasks with shared state updates.
 * Assumptions: run engine owns run state + store, passed in by reference.
 * Usage: const taskEngine = createTaskEngine(ctx); await taskEngine.runTaskAttempt(task).
 */

import path from "node:path";

import fse from "fs-extra";

import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import type { ChecksetDecision } from "../../../control-plane/policy/checkset.js";
import { evaluateTaskPolicyDecision, type ChecksetReport } from "../../../control-plane/policy/eval.js";
import type { PolicyDecision, SurfacePatternSet } from "../../../control-plane/policy/types.js";
import type { DerivedScopeReport } from "../../../control-plane/integration/derived-scope.js";
import { ensureCodexAuthForHome } from "../../../core/codexAuth.js";
import { resolveCodexReasoningEffort } from "../../../core/codex-reasoning.js";
import type { ProjectConfig } from "../../../core/config.js";
import {
  JsonlLogger,
  logOrchestratorEvent,
  logTaskReset,
} from "../../../core/logger.js";
import {
  taskChecksetReportPath,
  taskEventsLogPath,
  taskLogsDir,
  taskPolicyReportPath,
  taskWorkspaceDir,
  workerCodexHomeDir,
} from "../../../core/paths.js";
import type { PathsContext } from "../../../core/paths.js";
import type { StateStore } from "../../../core/state-store.js";
import type { CheckpointCommit, RunState } from "../../../core/state.js";
import { moveTaskDir, resolveTaskDir } from "../../../core/task-layout.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import { ensureDir, writeJsonFile } from "../../../core/utils.js";
import { prepareTaskWorkspace } from "../../../core/workspaces.js";
import { loadWorkerState, type WorkerCheckpoint } from "../../../../worker/state.js";

import { formatErrorMessage } from "../helpers/errors.js";
import type { ControlPlaneRunConfig } from "../run-context.js";
import type { Vcs } from "../vcs/vcs.js";
import type { WorkerRunner, WorkerRunnerResult } from "../workers/worker-runner.js";


// =============================================================================
// TYPES
// =============================================================================

export type TaskSuccessResult = {
  success: true;
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
};

export type TaskFailureResult = {
  success: false;
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
  errorMessage?: string;
  resetToPending?: boolean;
};

export type TaskRunResult = TaskSuccessResult | TaskFailureResult;

export type TaskEngineContext = {
  projectName: string;
  runId: string;
  config: ProjectConfig;
  state: RunState;
  stateStore: StateStore;
  tasksRootAbs: string;
  repoPath: string;
  paths?: PathsContext;
  workerRunner: WorkerRunner;
  vcs: Vcs;
  orchestratorLog: JsonlLogger;
  mockLlmMode: boolean;
  crashAfterContainerStart: boolean;
  controlPlaneConfig: ControlPlaneRunConfig;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  blastContext: BlastRadiusContext | null;
  policyDecisions: Map<string, PolicyDecision>;
};

export type TaskEngine = {
  buildReadyForValidationSummaries(batchTasks: TaskSpec[]): TaskSuccessResult[];
  buildValidatedTaskSummaries(batchTasks: TaskSpec[]): TaskSuccessResult[];
  ensureTaskActiveStage(task: TaskSpec): Promise<void>;
  resumeRunningTask(task: TaskSpec): Promise<TaskRunResult>;
  runTaskAttempt(task: TaskSpec): Promise<TaskRunResult>;
};


// =============================================================================
// POLICY DECISIONS
// =============================================================================

type BlastRadiusContext = {
  baseSha: string;
  model: ControlPlaneModel;
};

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
  checksConfig: ControlPlaneRunConfig["checks"];
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


// =============================================================================
// TASK ENGINE
// =============================================================================

export function createTaskEngine(context: TaskEngineContext): TaskEngine {
  const resolveTaskMeta = (
    task: TaskSpec,
  ): { branchName: string; workspace: string; logsDir: string } => {
    const taskId = task.manifest.id;
    const taskState = context.state.tasks[taskId];
    if (!taskState) {
      throw new Error(`Unknown task in state: ${taskId}`);
    }

    const branchName =
      taskState.branch ?? context.vcs.buildTaskBranchName(taskId, task.manifest.name);
    const workspace =
      taskState.workspace ?? taskWorkspaceDir(context.projectName, context.runId, taskId, context.paths);
    const logsDir =
      taskState.logs_dir ??
      taskLogsDir(context.projectName, context.runId, taskId, task.slug, context.paths);

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
      tasksRoot: context.tasksRootAbs,
      fromStage: "backlog",
      toStage: "active",
      taskDirName: task.taskDirName,
    });

    task.stage = "active";

    if (moveResult.moved) {
      logOrchestratorEvent(context.orchestratorLog, "task.stage.move", {
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

      const taskState = context.state.tasks[taskId];
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOrchestratorEvent(context.orchestratorLog, "worker.state.read_error", {
        taskId,
        message,
      });
      return false;
    }
  };

  const buildReadyForValidationSummaries = (batchTasks: TaskSpec[]): TaskSuccessResult[] => {
    const summaries: TaskSuccessResult[] = [];
    for (const task of batchTasks) {
      const taskState = context.state.tasks[task.manifest.id];
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
      const taskState = context.state.tasks[task.manifest.id];
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

  const resumeRunningTask = async (task: TaskSpec): Promise<TaskRunResult> => {
    const taskId = task.manifest.id;
    const taskState = context.state.tasks[taskId];
    const meta = resolveTaskMeta(task);

    await ensureTaskActiveStage(task);
    await syncWorkerStateIntoTask(taskId, meta.workspace);
    const taskEventsPath = taskEventsLogPath(
      context.projectName,
      context.runId,
      taskId,
      task.slug,
      context.paths,
    );
    await ensureDir(path.dirname(taskEventsPath));
    const taskEvents = new JsonlLogger(taskEventsPath, { runId: context.runId, taskId });

    let resumeResult: WorkerRunnerResult;
    try {
      resumeResult = await context.workerRunner.resumeAttempt({
        taskId,
        taskSlug: task.slug,
        workspace: meta.workspace,
        containerIdHint: taskState?.container_id,
        taskEvents,
        orchestratorLogger: context.orchestratorLog,
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
      logTaskReset(context.orchestratorLog, taskId, reason);
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

  const runTaskAttempt = async (task: TaskSpec): Promise<TaskRunResult> => {
    const taskId = task.manifest.id;
    const taskSlug = task.slug;
    await ensureTaskActiveStage(task);
    const branchName = context.vcs.buildTaskBranchName(taskId, task.manifest.name);
    const defaultDoctorCommand = task.manifest.verify?.doctor ?? context.config.doctor;
    const defaultLintCommand = task.manifest.verify?.lint ?? context.config.lint;
    const lintCommand = defaultLintCommand?.trim() || undefined;
    const policyResult = context.controlPlaneConfig.enabled
      ? computeTaskPolicyDecision({
          task,
          derivedScopeReports: context.derivedScopeReports,
          componentResourcePrefix: context.controlPlaneConfig.componentResourcePrefix,
          blastContext: context.blastContext,
          checksConfig: context.controlPlaneConfig.checks,
          defaultDoctorCommand,
          surfacePatterns: context.controlPlaneConfig.surfacePatterns,
          fallbackResource: context.controlPlaneConfig.fallbackResource,
        })
      : null;

    if (policyResult) {
      context.policyDecisions.set(taskId, policyResult.policyDecision);
      const policyReportPath = taskPolicyReportPath(context.repoPath, context.runId, taskId);
      try {
        await writeJsonFile(policyReportPath, policyResult.policyDecision);
      } catch (error) {
        logOrchestratorEvent(context.orchestratorLog, "task.policy.error", {
          taskId,
          task_slug: taskSlug,
          message: formatErrorMessage(error),
        });
      }

      const reportPath = taskChecksetReportPath(context.repoPath, context.runId, taskId);
      try {
        await writeJsonFile(reportPath, policyResult.checksetReport);
      } catch (error) {
        logOrchestratorEvent(context.orchestratorLog, "task.checkset.error", {
          taskId,
          task_slug: taskSlug,
          message: formatErrorMessage(error),
        });
      }
    }

    const doctorCommand = policyResult ? policyResult.doctorCommand : defaultDoctorCommand;

    const workspace = taskWorkspaceDir(context.projectName, context.runId, taskId, context.paths);
    const tLogsDir = taskLogsDir(
      context.projectName,
      context.runId,
      taskId,
      taskSlug,
      context.paths,
    );
    const codexHome = workerCodexHomeDir(
      context.projectName,
      context.runId,
      taskId,
      taskSlug,
      context.paths,
    );
    const codexConfigPath = path.join(codexHome, "config.toml");
    const codexReasoningEffort = resolveCodexReasoningEffort(
      context.config.worker.model,
      context.config.worker.reasoning_effort,
    );
    const taskAbsoluteDir = resolveTaskDir({
      tasksRoot: context.tasksRootAbs,
      stage: task.stage,
      taskDirName: task.taskDirName,
    });
    const taskRelativeDir = path.relative(context.tasksRootAbs, taskAbsoluteDir);
    const taskRelativeDirPosix = taskRelativeDir.split(path.sep).join(path.posix.sep);

    await ensureDir(tLogsDir);

    logOrchestratorEvent(context.orchestratorLog, "workspace.prepare.start", {
      taskId,
      workspace,
    });
    const workspacePrep = await prepareTaskWorkspace({
      projectName: context.projectName,
      runId: context.runId,
      taskId,
      repoPath: context.repoPath,
      mainBranch: context.config.main_branch,
      taskBranch: branchName,
      paths: context.paths,
    });
    logOrchestratorEvent(context.orchestratorLog, "workspace.prepare.complete", {
      taskId,
      workspace,
      created: workspacePrep.created,
    });

    await ensureDir(codexHome);
    await writeCodexConfig(codexConfigPath, {
      model: context.config.worker.model,
      modelReasoningEffort: codexReasoningEffort,
      // "never" means no approval prompts (unattended runs). See Codex config reference.
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
    // If the user authenticated via `codex login`, auth material typically lives under
    // ~/.codex/auth.json (file-based storage). Because we run each worker with a custom
    // CODEX_HOME, we copy that auth file into this per-task CODEX_HOME when no API key is provided.
    if (!context.mockLlmMode) {
      const auth = await ensureCodexAuthForHome(codexHome);
      logOrchestratorEvent(context.orchestratorLog, "codex.auth", {
        taskId,
        mode: auth.mode,
        source: auth.mode === "env" ? auth.var : "auth.json",
      });
    } else {
      logOrchestratorEvent(context.orchestratorLog, "codex.auth", {
        taskId,
        mode: "mock",
        source: "MOCK_LLM",
      });
    }

    // Ensure tasks directory is available inside the clone (copy from integration repo).
    const srcTasksDir = path.join(context.repoPath, context.config.tasks_dir);
    const destTasksDir = path.join(workspace, context.config.tasks_dir);
    await fse.remove(destTasksDir);
    await fse.copy(srcTasksDir, destTasksDir);

    await syncWorkerStateIntoTask(taskId, workspace);

    // Prepare per-task logger.
    const taskEvents = new JsonlLogger(
      taskEventsLogPath(context.projectName, context.runId, taskId, taskSlug, context.paths),
      { runId: context.runId, taskId },
    );

    context.state.tasks[taskId].branch = branchName;
    context.state.tasks[taskId].workspace = workspace;
    context.state.tasks[taskId].logs_dir = tLogsDir;
    await context.stateStore.save(context.state);

    const manifestPath = path.join(
      workspace,
      context.config.tasks_dir,
      taskRelativeDir,
      "manifest.json",
    );
    const specPath = path.join(workspace, context.config.tasks_dir, taskRelativeDir, "spec.md");

    let attemptResult: WorkerRunnerResult;
    try {
      attemptResult = await context.workerRunner.runAttempt({
        taskId,
        taskSlug,
        taskBranch: branchName,
        workspace,
        taskPaths: {
          manifestPath,
          specPath,
          taskRelativeDirPosix,
        },
        lintCommand,
        lintTimeoutSeconds: context.config.lint_timeout,
        doctorCommand,
        doctorTimeoutSeconds: context.config.doctor_timeout,
        maxRetries: context.config.max_retries,
        bootstrapCmds: context.config.bootstrap,
        runLogsDir: tLogsDir,
        codexHome,
        codexModel: context.config.worker.model,
        codexModelReasoningEffort: codexReasoningEffort,
        checkpointCommits: context.config.worker.checkpoint_commits,
        defaultTestPaths: context.config.test_paths,
        logCodexPrompts: context.config.worker.log_codex_prompts,
        crashAfterStart: context.crashAfterContainerStart,
        taskEvents,
        orchestratorLogger: context.orchestratorLog,
        onContainerReady: async (containerId) => {
          context.state.tasks[taskId].container_id = containerId;
          await context.stateStore.save(context.state);
        },
      });
    } finally {
      taskEvents.close();
    }

    if (attemptResult.containerId) {
      context.state.tasks[taskId].container_id = attemptResult.containerId;
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
  };

  return {
    buildReadyForValidationSummaries,
    buildValidatedTaskSummaries,
    ensureTaskActiveStage,
    resumeRunningTask,
    runTaskAttempt,
  };
}


// =============================================================================
// WORKER STATE HELPERS
// =============================================================================

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

export function checkpointListsEqual(
  a: CheckpointCommit[],
  b: CheckpointCommit[],
): boolean {
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
