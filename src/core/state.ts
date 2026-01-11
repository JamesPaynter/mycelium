import { z } from "zod";

import { isoNow } from "./utils.js";
import { LocksSchema, type NormalizedLocks } from "./task-manifest.js";

export const TaskStatusSchema = z.enum(["pending", "running", "complete", "failed", "skipped"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BatchStatusSchema = z.enum(["pending", "running", "complete", "failed"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const RunStatusSchema = z.enum(["running", "complete", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskStateSchema = z.object({
  status: TaskStatusSchema,
  batch_id: z.number().int().optional(),
  branch: z.string().optional(),
  container_id: z.string().optional(),
  workspace: z.string().optional(),
  logs_dir: z.string().optional(),
  attempts: z.number().int().default(0),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  last_error: z.string().optional(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;

export const BatchStateSchema = z.object({
  batch_id: z.number().int(),
  status: BatchStatusSchema,
  tasks: z.array(z.string()),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  merge_commit: z.string().optional(),
  integration_doctor_passed: z.boolean().optional(),
  locks: LocksSchema.optional(),
});

export type BatchState = z.infer<typeof BatchStateSchema>;

export const RunStateSchema = z.object({
  run_id: z.string(),
  project: z.string(),
  repo_path: z.string(),
  main_branch: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  status: RunStatusSchema,
  batches: z.array(BatchStateSchema),
  tasks: z.record(TaskStateSchema),
});

export type RunState = z.infer<typeof RunStateSchema>;

export function createRunState(args: {
  runId: string;
  project: string;
  repoPath: string;
  mainBranch: string;
  taskIds: string[];
}): RunState {
  const now = isoNow();
  const tasks: Record<string, TaskState> = {};
  for (const id of args.taskIds) {
    tasks[id] = { status: "pending", attempts: 0 };
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

export function markTaskComplete(
  state: RunState,
  taskId: string,
  now: string = isoNow(),
): void {
  const task = requireTask(state, taskId);
  if (task.status !== "running") {
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

export function completeBatch(
  state: RunState,
  batchId: number,
  status: BatchStatus,
  meta: { mergeCommit?: string; integrationDoctorPassed?: boolean } = {},
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

    task.status = "pending";
    task.batch_id = undefined;
    task.branch = undefined;
    task.container_id = undefined;
    task.workspace = undefined;
    task.logs_dir = undefined;
    task.started_at = undefined;
    task.completed_at = undefined;
    task.last_error = reason;
  }
}

function requireTask(state: RunState, taskId: string): TaskState {
  const task = state.tasks[taskId];
  if (!task) {
    throw new Error(`Unknown task in state: ${taskId}`);
  }
  return task;
}
