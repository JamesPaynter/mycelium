import path from "node:path";

import fse from "fs-extra";

import { loadWorkerState, type WorkerCheckpoint } from "../../../../worker/state.js";
import { JsonlLogger, logOrchestratorEvent } from "../../../core/logger.js";
import {
  taskEventsLogPath,
  taskLogsDir,
  taskWorkspaceDir,
} from "../../../core/paths.js";
import type { CheckpointCommit } from "../../../core/state.js";
import { moveTaskDir } from "../../../core/task-layout.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import { ensureDir } from "../../../core/utils.js";

import type { TaskEngineContext, TaskSuccessResult } from "./task-engine.js";

// =============================================================================
// TASK META
// =============================================================================

export function resolveTaskMeta(
  context: TaskEngineContext,
  task: TaskSpec,
): { branchName: string; workspace: string; logsDir: string } {
  const taskId = task.manifest.id;
  const taskState = context.state.tasks[taskId];
  if (!taskState) {
    throw new Error(`Unknown task in state: ${taskId}`);
  }

  const branchName =
    taskState.branch ?? context.vcs.buildTaskBranchName(taskId, task.manifest.name);
  const workspace =
    taskState.workspace ??
    taskWorkspaceDir(context.projectName, context.runId, taskId, context.paths);
  const logsDir =
    taskState.logs_dir ??
    taskLogsDir(context.projectName, context.runId, taskId, task.slug, context.paths);

  taskState.branch = branchName;
  taskState.workspace = workspace;
  taskState.logs_dir = logsDir;

  return { branchName, workspace, logsDir };
}

export async function ensureTaskActiveStage(
  context: TaskEngineContext,
  task: TaskSpec,
): Promise<void> {
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
}

// =============================================================================
// WORKER STATE
// =============================================================================

export async function syncWorkerStateIntoTask(
  context: TaskEngineContext,
  taskId: string,
  workspace: string,
): Promise<boolean> {
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

// =============================================================================
// SUMMARIES
// =============================================================================

export function buildReadyForValidationSummaries(
  context: TaskEngineContext,
  batchTasks: TaskSpec[],
): TaskSuccessResult[] {
  const summaries: TaskSuccessResult[] = [];
  for (const task of batchTasks) {
    const taskState = context.state.tasks[task.manifest.id];
    if (!taskState || taskState.status !== "running") continue;

    const meta = resolveTaskMeta(context, task);
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
}

export function buildValidatedTaskSummaries(
  context: TaskEngineContext,
  batchTasks: TaskSpec[],
): TaskSuccessResult[] {
  const summaries: TaskSuccessResult[] = [];
  for (const task of batchTasks) {
    const taskState = context.state.tasks[task.manifest.id];
    if (!taskState || taskState.status !== "validated") continue;

    const meta = resolveTaskMeta(context, task);
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
}

// =============================================================================
// CODEX CONFIG
// =============================================================================

export async function writeCodexConfig(
  filePath: string,
  opts: {
    model: string;
    modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  },
): Promise<void> {
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

export async function createTaskEventLogger(input: {
  projectName: string;
  runId: string;
  taskId: string;
  taskSlug: string;
  paths?: TaskEngineContext["paths"];
}): Promise<JsonlLogger> {
  const taskEventsPath = taskEventsLogPath(
    input.projectName,
    input.runId,
    input.taskId,
    input.taskSlug,
    input.paths,
  );
  await ensureDir(path.dirname(taskEventsPath));
  return new JsonlLogger(taskEventsPath, { runId: input.runId, taskId: input.taskId });
}
