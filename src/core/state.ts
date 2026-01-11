import { z } from "zod";
import { isoNow } from "./utils.js";
import { readJsonFile, writeJsonFile } from "./utils.js";

export const TaskStatusSchema = z.enum(["pending", "running", "complete", "failed", "skipped"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BatchStatusSchema = z.enum(["pending", "running", "complete", "failed"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

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
  last_error: z.string().optional()
});

export type TaskState = z.infer<typeof TaskStateSchema>;

export const BatchStateSchema = z.object({
  batch_id: z.number().int(),
  status: BatchStatusSchema,
  tasks: z.array(z.string()),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  merge_commit: z.string().optional(),
  integration_doctor_passed: z.boolean().optional()
});

export type BatchState = z.infer<typeof BatchStateSchema>;

export const RunStateSchema = z.object({
  run_id: z.string(),
  project: z.string(),
  repo_path: z.string(),
  main_branch: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  status: z.enum(["running", "complete", "failed"]),
  batches: z.array(BatchStateSchema),
  tasks: z.record(TaskStateSchema)
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
    tasks
  };
}

export async function loadRunState(statePath: string): Promise<RunState> {
  const raw = await readJsonFile<unknown>(statePath);
  const parsed = RunStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid run state at ${statePath}: ${parsed.error.toString()}`);
  }
  return parsed.data;
}

export async function saveRunState(statePath: string, state: RunState): Promise<void> {
  state.updated_at = isoNow();
  await writeJsonFile(statePath, state);
}
