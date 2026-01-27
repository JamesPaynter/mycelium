import { logTaskReset } from "../../../core/logger.js";
import type { TaskFailurePolicy } from "../../../core/config.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { WorkerRunnerResult } from "../workers/worker-runner.js";

import { shouldResetTaskToPending } from "./failure-policy.js";
import {
  createTaskEventLogger,
  ensureTaskActiveStage,
  resolveTaskMeta,
  syncWorkerStateIntoTask,
} from "./task-engine-helpers.js";
import type { TaskEngineContext, TaskRunResult } from "./task-engine.js";

export async function resumeRunningTask(
  context: TaskEngineContext,
  failurePolicy: TaskFailurePolicy,
  task: TaskSpec,
): Promise<TaskRunResult> {
  const taskId = task.manifest.id;
  const taskState = context.state.tasks[taskId];
  const meta = resolveTaskMeta(context, task);

  await ensureTaskActiveStage(context, task);
  await syncWorkerStateIntoTask(context, taskId, meta.workspace);

  const taskEvents = await createTaskEventLogger({
    projectName: context.projectName,
    runId: context.runId,
    taskId,
    taskSlug: task.slug,
    paths: context.paths,
  });

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

  await syncWorkerStateIntoTask(context, taskId, meta.workspace);

  const shouldReset = shouldResetTaskToPending({
    policy: failurePolicy,
    result: resumeResult,
  });

  if (shouldReset) {
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
}
