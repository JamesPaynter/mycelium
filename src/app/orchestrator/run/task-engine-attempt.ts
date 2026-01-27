import { resolveCodexReasoningEffort } from "../../../core/codex-reasoning.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { WorkerRunnerResult } from "../workers/worker-runner.js";

import { shouldResetTaskToPending } from "./failure-policy.js";
import {
  buildTaskAttemptPaths,
  copyTaskDefinitions,
  persistTaskAttemptState,
  prepareCodexEnvironment,
  prepareWorkspace,
  resolveTaskPolicyInputs,
  writeTaskPolicyReports,
} from "./task-engine-attempt-helpers.js";
import {
  createTaskEventLogger,
  ensureTaskActiveStage,
  syncWorkerStateIntoTask,
} from "./task-engine-helpers.js";
import type { TaskEngineContext, TaskRunResult } from "./task-engine.js";

function buildSuccessResult(input: {
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
}): TaskRunResult {
  return {
    taskId: input.taskId,
    taskSlug: input.taskSlug,
    branchName: input.branchName,
    workspace: input.workspace,
    logsDir: input.logsDir,
    success: true as const,
  };
}

function buildFailureResult(input: {
  taskId: string;
  taskSlug: string;
  branchName: string;
  workspace: string;
  logsDir: string;
  failurePolicy: string;
  attemptResult: WorkerRunnerResult;
}): TaskRunResult {
  const shouldResetAttempt = shouldResetTaskToPending({
    policy: input.failurePolicy,
    result: input.attemptResult,
  });

  return {
    taskId: input.taskId,
    taskSlug: input.taskSlug,
    branchName: input.branchName,
    workspace: input.workspace,
    logsDir: input.logsDir,
    errorMessage: input.attemptResult.errorMessage,
    success: false as const,
    ...(shouldResetAttempt ? { resetToPending: true } : {}),
  };
}

// =============================================================================
// TASK ATTEMPT
// =============================================================================

export async function runTaskAttempt(
  context: TaskEngineContext,
  failurePolicy: string,
  task: TaskSpec,
): Promise<TaskRunResult> {
  const taskId = task.manifest.id;
  const taskSlug = task.slug;
  await ensureTaskActiveStage(context, task);

  const branchName = context.vcs.buildTaskBranchName(taskId, task.manifest.name);
  const { policyResult, lintCommand, doctorCommand } = resolveTaskPolicyInputs(context, task);
  await writeTaskPolicyReports(context, taskId, taskSlug, policyResult);

  const attemptPaths = buildTaskAttemptPaths(context, task, taskId, taskSlug);
  const codexReasoningEffort = resolveCodexReasoningEffort(
    context.config.worker.model,
    context.config.worker.reasoning_effort,
  );

  await prepareWorkspace({
    context,
    taskId,
    branchName,
    workspace: attemptPaths.workspace,
    logsDir: attemptPaths.logsDir,
    failurePolicy,
  });
  await prepareCodexEnvironment({
    context,
    taskId,
    codexHome: attemptPaths.codexHome,
    codexConfigPath: attemptPaths.codexConfigPath,
    codexReasoningEffort,
  });
  await copyTaskDefinitions(context, attemptPaths.workspace);
  await syncWorkerStateIntoTask(context, taskId, attemptPaths.workspace);

  const taskEvents = await createTaskEventLogger({
    projectName: context.projectName,
    runId: context.runId,
    taskId,
    taskSlug,
    paths: context.paths,
  });

  await persistTaskAttemptState({
    context,
    taskId,
    branchName,
    workspace: attemptPaths.workspace,
    logsDir: attemptPaths.logsDir,
  });

  let attemptResult: WorkerRunnerResult;
  try {
    attemptResult = await context.workerRunner.runAttempt({
      taskId,
      taskSlug,
      taskBranch: branchName,
      workspace: attemptPaths.workspace,
      taskPaths: {
        manifestPath: attemptPaths.manifestPath,
        specPath: attemptPaths.specPath,
        taskRelativeDirPosix: attemptPaths.taskRelativeDirPosix,
      },
      lintCommand,
      lintTimeoutSeconds: context.config.lint_timeout,
      doctorCommand,
      doctorTimeoutSeconds: context.config.doctor_timeout,
      maxRetries: context.config.max_retries,
      bootstrapCmds: context.config.bootstrap,
      runLogsDir: attemptPaths.logsDir,
      codexHome: attemptPaths.codexHome,
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

  await syncWorkerStateIntoTask(context, taskId, attemptPaths.workspace);

  if (attemptResult.success) {
    return buildSuccessResult({
      taskId,
      taskSlug,
      branchName,
      workspace: attemptPaths.workspace,
      logsDir: attemptPaths.logsDir,
    });
  }

  return buildFailureResult({
    taskId,
    taskSlug,
    branchName,
    workspace: attemptPaths.workspace,
    logsDir: attemptPaths.logsDir,
    failurePolicy,
    attemptResult,
  });
}
