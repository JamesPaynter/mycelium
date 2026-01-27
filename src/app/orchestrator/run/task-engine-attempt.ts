import path from "node:path";

import fse from "fs-extra";

import { resolveCodexReasoningEffort } from "../../../core/codex-reasoning.js";
import { ensureCodexAuthForHome } from "../../../core/codexAuth.js";
import { logOrchestratorEvent } from "../../../core/logger.js";
import {
  taskChecksetReportPath,
  taskLogsDir,
  taskPolicyReportPath,
  taskWorkspaceDir,
  workerCodexHomeDir,
} from "../../../core/paths.js";
import { resolveTaskDir } from "../../../core/task-layout.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import { ensureDir, writeJsonFile } from "../../../core/utils.js";
import { prepareTaskWorkspace } from "../../../core/workspaces.js";
import { formatErrorMessage } from "../helpers/errors.js";
import type { WorkerRunnerResult } from "../workers/worker-runner.js";

import { shouldResetTaskToPending } from "./failure-policy.js";
import {
  createTaskEventLogger,
  ensureTaskActiveStage,
  syncWorkerStateIntoTask,
  writeCodexConfig,
} from "./task-engine-helpers.js";
import { computeTaskPolicyDecision } from "./task-engine-policy.js";
import type { TaskEngineContext, TaskRunResult } from "./task-engine.js";

export async function runTaskAttempt(
  context: TaskEngineContext,
  failurePolicy: string,
  task: TaskSpec,
): Promise<TaskRunResult> {
  const taskId = task.manifest.id;
  const taskSlug = task.slug;
  await ensureTaskActiveStage(context, task);
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
  const tLogsDir = taskLogsDir(context.projectName, context.runId, taskId, taskSlug, context.paths);
  const codexHome = workerCodexHomeDir(context.projectName, context.runId, taskId, taskSlug, context.paths);
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
    recoverDirtyWorkspace: failurePolicy === "retry",
  });
  logOrchestratorEvent(context.orchestratorLog, "workspace.prepare.complete", {
    taskId,
    workspace,
    created: workspacePrep.created,
  });
  if (workspacePrep.recovered) {
    logOrchestratorEvent(context.orchestratorLog, "workspace.recovered", {
      taskId,
      workspace,
      method: "git_reset_clean",
    });
  }

  await ensureDir(codexHome);
  await writeCodexConfig(codexConfigPath, {
    model: context.config.worker.model,
    modelReasoningEffort: codexReasoningEffort,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  });
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

  const srcTasksDir = path.join(context.repoPath, context.config.tasks_dir);
  const destTasksDir = path.join(workspace, context.config.tasks_dir);
  await fse.remove(destTasksDir);
  await fse.copy(srcTasksDir, destTasksDir);

  await syncWorkerStateIntoTask(context, taskId, workspace);

  const taskEvents = await createTaskEventLogger({
    projectName: context.projectName,
    runId: context.runId,
    taskId,
    taskSlug,
    paths: context.paths,
  });

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

  await syncWorkerStateIntoTask(context, taskId, workspace);

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

  const shouldResetAttempt = shouldResetTaskToPending({
    policy: failurePolicy,
    result: attemptResult,
  });

  return {
    taskId,
    taskSlug,
    branchName,
    workspace,
    logsDir: tLogsDir,
    errorMessage: attemptResult.errorMessage,
    success: false as const,
    ...(shouldResetAttempt ? { resetToPending: true } : {}),
  };
}
