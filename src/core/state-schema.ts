import { z } from "zod";

import { ValidatorModeSchema } from "./config.js";
import { LocksSchema } from "./task-manifest.js";

// =============================================================================
// STATUS ENUMS
// =============================================================================

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "validated",
  "complete",
  "failed",
  "needs_human_review",
  "needs_rescope",
  "rescope_required",
  "skipped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskOverrideStatusSchema = z.enum(["pending", "complete", "skipped"]);
export type TaskOverrideStatus = z.infer<typeof TaskOverrideStatusSchema>;

export const BatchStatusSchema = z.enum(["pending", "running", "complete", "failed"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const RunStatusSchema = z.enum(["running", "paused", "complete", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// =============================================================================
// VALIDATION & USAGE
// =============================================================================

export const CheckpointCommitSchema = z.object({
  attempt: z.number().int().positive(),
  sha: z.string(),
  created_at: z.string().optional(),
});
export type CheckpointCommit = z.infer<typeof CheckpointCommitSchema>;

export const ValidatorIdSchema = z.enum(["test", "style", "architecture", "doctor"]);
export type ValidatorId = z.infer<typeof ValidatorIdSchema>;

export const ValidatorStatusSchema = z.enum(["pass", "fail", "error", "skip"]);
export type ValidatorStatus = z.infer<typeof ValidatorStatusSchema>;

export const ValidatorResultSchema = z
  .object({
    validator: ValidatorIdSchema,
    status: ValidatorStatusSchema,
    mode: ValidatorModeSchema,
    summary: z.string().optional(),
    report_path: z.string().optional(),
    trigger: z.string().optional(),
  })
  .strict();
export type ValidatorResult = z.infer<typeof ValidatorResultSchema>;

export const HumanReviewSchema = z
  .object({
    validator: ValidatorIdSchema,
    reason: z.string(),
    summary: z.string().optional(),
    report_path: z.string().optional(),
  })
  .strict();
export type HumanReview = z.infer<typeof HumanReviewSchema>;

export const AttemptUsageSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    estimated_cost: z.number().nonnegative(),
  })
  .strict();
export type AttemptUsage = z.infer<typeof AttemptUsageSchema>;

// =============================================================================
// STATE SHAPES
// =============================================================================

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
  thread_id: z.string().optional(),
  checkpoint_commits: z.array(CheckpointCommitSchema).default([]),
  validator_results: z.array(ValidatorResultSchema).default([]),
  human_review: HumanReviewSchema.optional(),
  tokens_used: z.number().int().nonnegative().default(0),
  estimated_cost: z.number().nonnegative().default(0),
  usage_by_attempt: z.array(AttemptUsageSchema).default([]),
});

export type TaskState = z.infer<typeof TaskStateSchema>;

export const DoctorCanarySummarySchema = z
  .object({
    status: z.enum(["expected_fail", "unexpected_pass", "skipped"]),
    env_var: z.string().optional(),
    exit_code: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict();

export type DoctorCanarySummary = z.infer<typeof DoctorCanarySummarySchema>;

export const BatchStateSchema = z.object({
  batch_id: z.number().int(),
  status: BatchStatusSchema,
  tasks: z.array(z.string()),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  merge_commit: z.string().optional(),
  integration_doctor_passed: z.boolean().optional(),
  integration_doctor_canary: DoctorCanarySummarySchema.optional(),
  locks: LocksSchema.optional(),
});

export type BatchState = z.infer<typeof BatchStateSchema>;

export const ControlPlaneSnapshotSchema = z.object({
  enabled: z.boolean(),
  base_sha: z.string().optional(),
  model_hash: z.string().optional(),
  model_path: z.string().optional(),
  built_at: z.string().optional(),
  schema_version: z.number().int().optional(),
  extractor_versions: z.record(z.string()).optional(),
});

export type ControlPlaneSnapshot = z.infer<typeof ControlPlaneSnapshotSchema>;

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
  tokens_used: z.number().int().nonnegative().default(0),
  estimated_cost: z.number().nonnegative().default(0),
  control_plane: ControlPlaneSnapshotSchema.optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;
