import { z } from "zod";

import { DEFAULT_TEST_PATHS } from "./test-paths.js";

// =============================================================================
// SCHEMAS
// =============================================================================

const LlmProviderSchema = z.enum(["openai", "anthropic", "codex"]);
export const ValidatorModeSchema = z.enum(["off", "warn", "block"]);

const ResourceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    paths: z.array(z.string()).min(1),
  })
  .strict();

const PlannerSchema = z
  .object({
    provider: LlmProviderSchema.default("codex"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

const WorkerSchema = z
  .object({
    model: z.string().min(1),
    max_retries: z.number().int().positive().optional(),
    checkpoint_commits: z.boolean().default(true),
  })
  .strict();

const ValidatorSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: ValidatorModeSchema.default("warn"),
    provider: LlmProviderSchema.default("openai"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

const DoctorValidatorSchema = ValidatorSchema.extend({
  run_every_n_tasks: z.number().int().positive().default(10),
}).strict();

const BudgetsSchema = z
  .object({
    max_tokens_per_task: z.number().int().positive().optional(),
    max_cost_per_run: z.number().nonnegative().optional(),
    mode: z.enum(["warn", "block"]).default("warn"),
  })
  .strict();

const DockerSchema = z
  .object({
    image: z.string().min(1).default("task-orchestrator-worker:latest"),
    dockerfile: z.string().default("templates/Dockerfile"),
    build_context: z.string().default("."),
  })
  .strict();

const ManifestEnforcementSchema = z.enum(["off", "warn", "block"]).default("warn");

export const ProjectConfigSchema = z
  .object({
    repo_path: z.string().min(1),
    main_branch: z.string().min(1).default("development-codex"),
    task_branch_prefix: z.string().min(1).default("agent/"),

    tasks_dir: z.string().min(1).default(".tasks"),

    max_parallel: z.number().int().positive().default(4),
    max_retries: z.number().int().positive().default(20),
    timeout_minutes: z.number().int().positive().optional(),

    doctor: z.string().min(1),
    doctor_timeout: z.number().int().positive().optional(),

    // Optional: run once in the worker container before Codex starts.
    // Example: ["npm ci", "npm test -- --help"]
    bootstrap: z.array(z.string()).default([]),

    test_paths: z.array(z.string()).default(DEFAULT_TEST_PATHS),

    resources: z.array(ResourceSchema).min(1),

    docker: DockerSchema.default({}),
    manifest_enforcement: ManifestEnforcementSchema.default("warn"),

    planner: PlannerSchema,
    worker: WorkerSchema,

    test_validator: ValidatorSchema.optional(),
    doctor_validator: DoctorValidatorSchema.optional(),
    budgets: BudgetsSchema.default({}),
  })
  .strict();

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type BudgetsConfig = z.infer<typeof BudgetsSchema>;
export type PlannerConfig = z.infer<typeof PlannerSchema>;
export type WorkerConfig = z.infer<typeof WorkerSchema>;
export type ValidatorConfig = z.infer<typeof ValidatorSchema>;
export type DoctorValidatorConfig = z.infer<typeof DoctorValidatorSchema>;
export type ValidatorMode = z.infer<typeof ValidatorModeSchema>;
export type ResourceConfig = z.infer<typeof ResourceSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ManifestEnforcementPolicy = z.infer<typeof ManifestEnforcementSchema>;
