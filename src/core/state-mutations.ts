import type {
  BatchStatus,
  ControlPlaneSnapshot,
  DoctorCanarySummary,
  RunState,
  TaskOverrideStatus,
  TaskState,
  ValidatorId,
} from "./state-schema.js";
import type { NormalizedLocks } from "./task-manifest.js";
import { isoNow } from "./utils.js";

// =============================================================================
// RUN STATE MUTATIONS
// =============================================================================

export function createRunState(args: {
  runId: string;
  project: string;
  repoPath: string;
  mainBranch: string;
  taskIds: string[];
  controlPlane?: ControlPlaneSnapshot;
}): RunState {
  const now = isoNow();
  const tasks: Record<string, TaskState> = {};
  for (const id of args.taskIds) {
    tasks[id] = {
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

  return {
    run_id: args.runId,
    project: args.project,
    repo_path: args.repoPath,
    main_branch: args.mainBranch,
    started_at: now,
    updated_at: now,
    status: "running",
    batches: [],
    tasks,
    tokens_used: 0,
    estimated_cost: 0,
    control_plane: args.controlPlane,
  };
}

export function startBatch(
  state: RunState,
  params: { batchId: number; taskIds: string[]; locks?: NormalizedLocks; now?: string },
): void {
  const { batchId, taskIds, locks, now = isoNow() } = params;

  if (state.status !== "running") {
    throw new Error(`Cannot start batch ${batchId} when run status is ${state.status}`);
  }
  if (taskIds.length === 0) {
    throw new Error("Cannot start an empty batch");
  }
  if (state.batches.some((b) => b.batch_id === batchId)) {
    throw new Error(`Batch ${batchId} already exists in state`);
  }

  state.batches.push({
    batch_id: batchId,
    status: "running",
    tasks: [...taskIds],
    started_at: now,
    locks,
  });

  for (const taskId of taskIds) {
    markTaskRunning(state, taskId, batchId, {}, now);
  }
}

export function markTaskRunning(
  state: RunState,
  taskId: string,
  batchId: number,
  meta: Partial<Pick<TaskState, "branch" | "container_id" | "workspace" | "logs_dir">> = {},
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "pending") {
    throw new Error(`Cannot start task ${taskId} from status ${task.status}`);
  }

  task.status = "running";
  task.batch_id = batchId;
  task.started_at = now;
  task.completed_at = undefined;
  task.last_error = undefined;
  task.attempts = (task.attempts ?? 0) + 1;

  if (meta.branch !== undefined) task.branch = meta.branch;
  if (meta.container_id !== undefined) task.container_id = meta.container_id;
  if (meta.workspace !== undefined) task.workspace = meta.workspace;
  if (meta.logs_dir !== undefined) task.logs_dir = meta.logs_dir;
}

export function markTaskValidated(state: RunState, taskId: string): void {
  const task = requireTask(state, taskId);
  if (task.status !== "running") {
    throw new Error(`Cannot mark task ${taskId} validated from status ${task.status}`);
  }

  task.status = "validated";
}

export function markTaskComplete(state: RunState, taskId: string, now: string = isoNow()): void {
  const task = requireTask(state, taskId);
  if (task.status !== "validated") {
    throw new Error(`Cannot mark task ${taskId} complete from status ${task.status}`);
  }

  task.status = "complete";
  task.completed_at = now;
}

export function markTaskFailed(
  state: RunState,
  taskId: string,
  errorMessage?: string,
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "running") {
    throw new Error(`Cannot mark task ${taskId} failed from status ${task.status}`);
  }

  task.status = "failed";
  task.completed_at = now;
  if (errorMessage) {
    task.last_error = errorMessage;
  }
}

export function markTaskNeedsRescope(
  state: RunState,
  taskId: string,
  reason?: string,
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "running") {
    throw new Error(`Cannot mark task ${taskId} needs_rescope from status ${task.status}`);
  }

  task.status = "needs_rescope";
  task.completed_at = now;
  if (reason) {
    task.last_error = reason;
  }
}

export function markTaskRescopeRequired(
  state: RunState,
  taskId: string,
  reason?: string,
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "running") {
    throw new Error(`Cannot mark task ${taskId} rescope_required from status ${task.status}`);
  }

  task.status = "rescope_required";
  task.completed_at = now;
  if (reason) {
    task.last_error = reason;
  }
}

export function completeBatch(
  state: RunState,
  batchId: number,
  status: BatchStatus,
  meta: {
    mergeCommit?: string;
    integrationDoctorPassed?: boolean;
    integrationDoctorCanary?: DoctorCanarySummary;
  } = {},
  now: string = isoNow(),
): void {
  if (status === "pending" || status === "running") {
    throw new Error(`Cannot complete batch ${batchId} with status ${status}`);
  }

  const batch = state.batches.find((b) => b.batch_id === batchId);
  if (!batch) {
    throw new Error(`Cannot complete unknown batch ${batchId}`);
  }

  batch.status = status;
  batch.completed_at = now;
  if (meta.mergeCommit !== undefined) batch.merge_commit = meta.mergeCommit;
  if (meta.integrationDoctorPassed !== undefined) {
    batch.integration_doctor_passed = meta.integrationDoctorPassed;
  }
  if (meta.integrationDoctorCanary !== undefined) {
    batch.integration_doctor_canary = meta.integrationDoctorCanary;
  }
}

export function resetRunningTasks(
  state: RunState,
  reason = "Recovered from crash: previous status was running",
): void {
  const now = isoNow();

  for (const batch of state.batches) {
    if (batch.status === "running") {
      batch.status = "failed";
      batch.completed_at = now;
    }
  }

  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running") continue;

    applyResetToPending(state, task, reason, now);
  }
}

export function resetTaskToPending(
  state: RunState,
  taskId: string,
  reason = "Recovered from crash: previous status was running",
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (
    task.status !== "running" &&
    task.status !== "validated" &&
    task.status !== "needs_human_review" &&
    task.status !== "needs_rescope" &&
    task.status !== "rescope_required"
  ) {
    throw new Error(`Cannot reset task ${taskId} from status ${task.status}`);
  }

  applyResetToPending(state, task, reason, now);
}

export function applyTaskStatusOverride(
  state: RunState,
  taskId: string,
  opts: { status: TaskOverrideStatus; force?: boolean; now?: string },
): void {
  const task = requireTask(state, taskId);
  if (task.status === "running" && !opts.force) {
    throw new Error(`Cannot override running task ${taskId} without --force`);
  }

  const now = opts.now ?? isoNow();
  const nextStatus = opts.status;

  task.status = nextStatus;

  if (nextStatus === "pending") {
    task.completed_at = undefined;
    task.last_error = undefined;
    task.human_review = undefined;
    return;
  }

  task.completed_at = now;
  task.last_error = undefined;
  task.human_review = undefined;
}

export function markTaskNeedsHumanReview(
  state: RunState,
  taskId: string,
  params: { validator: ValidatorId; reason: string; summary?: string; reportPath?: string },
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "complete" && task.status !== "running" && task.status !== "validated") {
    throw new Error(`Cannot mark task ${taskId} needs_human_review from status ${task.status}`);
  }

  task.status = "needs_human_review";
  task.completed_at = now;
  task.last_error = params.reason;
  task.human_review = {
    validator: params.validator,
    reason: params.reason,
    summary: params.summary,
    report_path: params.reportPath,
  };
}

function requireTask(state: RunState, taskId: string): TaskState {
  const task = state.tasks[taskId];
  if (!task) {
    throw new Error(`Unknown task in state: ${taskId}`);
  }
  return task;
}

function applyResetToPending(state: RunState, task: TaskState, reason: string, _now: string): void {
  task.status = "pending";
  task.batch_id = undefined;
  task.branch = undefined;
  task.container_id = undefined;
  task.workspace = undefined;
  task.logs_dir = undefined;
  task.started_at = undefined;
  task.completed_at = undefined;
  task.last_error = reason;
  task.validator_results = [];
  task.human_review = undefined;
}
