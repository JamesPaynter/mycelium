import path from "node:path";

import fse from "fs-extra";

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

import { writeCodexConfig } from "./task-engine-helpers.js";
import { computeTaskPolicyDecision } from "./task-engine-policy.js";
import type { TaskEngineContext } from "./task-engine.js";

// =============================================================================
// TASK POLICY
// =============================================================================

type TaskPolicyInputs = {
  policyResult: ReturnType<typeof computeTaskPolicyDecision> | null;
  lintCommand: string | undefined;
  doctorCommand: string;
};

export function resolveTaskPolicyInputs(
  context: TaskEngineContext,
  task: TaskSpec,
): TaskPolicyInputs {
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

  return {
    policyResult,
    lintCommand,
    doctorCommand: policyResult ? policyResult.doctorCommand : defaultDoctorCommand,
  };
}

export async function writeTaskPolicyReports(
  context: TaskEngineContext,
  taskId: string,
  taskSlug: string,
  policyResult: TaskPolicyInputs["policyResult"],
): Promise<void> {
  if (!policyResult) return;

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

// =============================================================================
// TASK PATHS
// =============================================================================

export type TaskAttemptPaths = {
  workspace: string;
  logsDir: string;
  codexHome: string;
  codexConfigPath: string;
  manifestPath: string;
  specPath: string;
  taskRelativeDirPosix: string;
};

export function buildTaskAttemptPaths(
  context: TaskEngineContext,
  task: TaskSpec,
  taskId: string,
  taskSlug: string,
): TaskAttemptPaths {
  const workspace = taskWorkspaceDir(context.projectName, context.runId, taskId, context.paths);
  const logsDir = taskLogsDir(context.projectName, context.runId, taskId, taskSlug, context.paths);
  const codexHome = workerCodexHomeDir(
    context.projectName,
    context.runId,
    taskId,
    taskSlug,
    context.paths,
  );
  const codexConfigPath = path.join(codexHome, "config.toml");

  const taskAbsoluteDir = resolveTaskDir({
    tasksRoot: context.tasksRootAbs,
    stage: task.stage,
    taskDirName: task.taskDirName,
  });
  const taskRelativeDir = path.relative(context.tasksRootAbs, taskAbsoluteDir);
  const taskRelativeDirPosix = taskRelativeDir.split(path.sep).join(path.posix.sep);

  return {
    workspace,
    logsDir,
    codexHome,
    codexConfigPath,
    manifestPath: path.join(workspace, context.config.tasks_dir, taskRelativeDir, "manifest.json"),
    specPath: path.join(workspace, context.config.tasks_dir, taskRelativeDir, "spec.md"),
    taskRelativeDirPosix,
  };
}

// =============================================================================
// WORKSPACE PREP
// =============================================================================

export async function prepareWorkspace(input: {
  context: TaskEngineContext;
  taskId: string;
  branchName: string;
  workspace: string;
  logsDir: string;
  failurePolicy: string;
}): Promise<void> {
  await ensureDir(input.logsDir);

  logOrchestratorEvent(input.context.orchestratorLog, "workspace.prepare.start", {
    taskId: input.taskId,
    workspace: input.workspace,
  });
  const workspacePrep = await prepareTaskWorkspace({
    projectName: input.context.projectName,
    runId: input.context.runId,
    taskId: input.taskId,
    repoPath: input.context.repoPath,
    mainBranch: input.context.config.main_branch,
    taskBranch: input.branchName,
    paths: input.context.paths,
    recoverDirtyWorkspace: input.failurePolicy === "retry",
  });
  logOrchestratorEvent(input.context.orchestratorLog, "workspace.prepare.complete", {
    taskId: input.taskId,
    workspace: input.workspace,
    created: workspacePrep.created,
  });
  if (workspacePrep.recovered) {
    logOrchestratorEvent(input.context.orchestratorLog, "workspace.recovered", {
      taskId: input.taskId,
      workspace: input.workspace,
      method: "git_reset_clean",
    });
  }
}

export async function prepareCodexEnvironment(input: {
  context: TaskEngineContext;
  taskId: string;
  codexHome: string;
  codexConfigPath: string;
  codexReasoningEffort: string;
}): Promise<void> {
  await ensureDir(input.codexHome);
  await writeCodexConfig(input.codexConfigPath, {
    model: input.context.config.worker.model,
    modelReasoningEffort: input.codexReasoningEffort,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  });
  if (!input.context.mockLlmMode) {
    const auth = await ensureCodexAuthForHome(input.codexHome);
    logOrchestratorEvent(input.context.orchestratorLog, "codex.auth", {
      taskId: input.taskId,
      mode: auth.mode,
      source: auth.mode === "env" ? auth.var : "auth.json",
    });
  } else {
    logOrchestratorEvent(input.context.orchestratorLog, "codex.auth", {
      taskId: input.taskId,
      mode: "mock",
      source: "MOCK_LLM",
    });
  }
}

export async function copyTaskDefinitions(
  context: TaskEngineContext,
  workspace: string,
): Promise<void> {
  const srcTasksDir = path.join(context.repoPath, context.config.tasks_dir);
  const destTasksDir = path.join(workspace, context.config.tasks_dir);
  await fse.remove(destTasksDir);
  await fse.copy(srcTasksDir, destTasksDir);
}

export async function persistTaskAttemptState(input: {
  context: TaskEngineContext;
  taskId: string;
  branchName: string;
  workspace: string;
  logsDir: string;
}): Promise<void> {
  input.context.state.tasks[input.taskId].branch = input.branchName;
  input.context.state.tasks[input.taskId].workspace = input.workspace;
  input.context.state.tasks[input.taskId].logs_dir = input.logsDir;
  await input.context.stateStore.save(input.context.state);
}
