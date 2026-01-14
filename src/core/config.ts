import { z } from "zod";

// =============================================================================
// SCHEMAS
// =============================================================================

const LlmProviderSchema = z.enum(["openai", "anthropic", "codex"]);

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
    provider: LlmProviderSchema.default("openai"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

const DoctorValidatorSchema = ValidatorSchema.extend({
  run_every_n_tasks: z.number().int().positive().default(10),
}).strict();

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

    resources: z.array(ResourceSchema).min(1),

    docker: DockerSchema.default({}),
    manifest_enforcement: ManifestEnforcementSchema.default("warn"),

    planner: PlannerSchema,
    worker: WorkerSchema,

    test_validator: ValidatorSchema.optional(),
    doctor_validator: DoctorValidatorSchema.optional(),
  })
  .strict();

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type PlannerConfig = z.infer<typeof PlannerSchema>;
export type WorkerConfig = z.infer<typeof WorkerSchema>;
export type ValidatorConfig = z.infer<typeof ValidatorSchema>;
export type DoctorValidatorConfig = z.infer<typeof DoctorValidatorSchema>;
export type ResourceConfig = z.infer<typeof ResourceSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ManifestEnforcementPolicy = z.infer<typeof ManifestEnforcementSchema>;
