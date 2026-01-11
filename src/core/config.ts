import { z } from "zod";

// =============================================================================
// SCHEMAS
// =============================================================================

const ResourceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    paths: z.array(z.string()).min(1),
  })
  .strict();

const PlannerSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "codex"]).default("codex"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

const WorkerSchema = z
  .object({
    model: z.string().min(1),
    max_retries: z.number().int().positive().optional(),
  })
  .strict();

const ValidatorSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.enum(["openai", "anthropic", "codex"]).default("openai"),
    model: z.string().min(1),
  })
  .strict();

const DockerSchema = z
  .object({
    image: z.string().min(1).default("task-orchestrator-worker:latest"),
    dockerfile: z.string().default("templates/worker.Dockerfile"),
    build_context: z.string().default("."),
  })
  .strict();

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
    bootstrap: z.array(z.string()).optional(),

    resources: z.array(ResourceSchema).min(1),

    docker: DockerSchema.default({}),

    planner: PlannerSchema,
    worker: WorkerSchema,

    test_validator: ValidatorSchema.optional(),
    doctor_validator: ValidatorSchema.optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
