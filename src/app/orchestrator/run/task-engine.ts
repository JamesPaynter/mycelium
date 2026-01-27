/**
 * TaskEngine handles per-task orchestration logic.
 * Purpose: run or resume tasks with shared state updates.
 * Assumptions: run engine owns run state + store, passed in by reference.
 * Usage: const taskEngine = createTaskEngine(ctx); await taskEngine.runTaskAttempt(task).
 */

import type { DerivedScopeReport } from "../../../control-plane/integration/derived-scope.js";
import type { PolicyDecision } from "../../../control-plane/policy/types.js";
import type { ProjectConfig } from "../../../core/config.js";
import { JsonlLogger } from "../../../core/logger.js";
import type { PathsContext } from "../../../core/paths.js";
import type { StateStore } from "../../../core/state-store.js";
import type { RunState } from "../../../core/state.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { ControlPlaneRunConfig } from "../run-context.js";
import type { Vcs } from "../vcs/vcs.js";
import type { WorkerRunner } from "../workers/worker-runner.js";

import {
  buildReadyForValidationSummaries,
  buildValidatedTaskSummaries,
  ensureTaskActiveStage,
} from "./task-engine-helpers.js";
import type { BlastRadiusContext } from "./task-engine-policy.js";
import { resumeRunningTask, runTaskAttempt } from "./task-engine-run.js";

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
// TASK ENGINE
// =============================================================================

export function createTaskEngine(context: TaskEngineContext): TaskEngine {
  const failurePolicy = context.config.task_failure_policy ?? "retry";
  return {
    buildReadyForValidationSummaries: (batchTasks) =>
      buildReadyForValidationSummaries(context, batchTasks),
    buildValidatedTaskSummaries: (batchTasks) =>
      buildValidatedTaskSummaries(context, batchTasks),
    ensureTaskActiveStage: (task) => ensureTaskActiveStage(context, task),
    resumeRunningTask: (task) => resumeRunningTask(context, failurePolicy, task),
    runTaskAttempt: (task) => runTaskAttempt(context, failurePolicy, task),
  };
}

export { checkpointListsEqual, mergeCheckpointCommits } from "./task-engine-helpers.js";
