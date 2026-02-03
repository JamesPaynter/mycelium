import { z } from "zod";

import { DEFAULT_TEST_PATHS } from "./test-paths.js";

// =============================================================================
// SCHEMAS
// =============================================================================

const LlmProviderSchema = z.enum(["openai", "anthropic", "codex", "mock"]);
export const ValidatorModeSchema = z.enum(["off", "warn", "block"]);

const ResourceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    paths: z.array(z.string()).min(1),
  })
  .strict();

const ControlPlaneResourcesModeSchema = z.enum(["prefer-derived"]);
const ControlPlaneScopeModeSchema = z.enum(["off", "shadow", "enforce"]);
const ControlPlaneLockModeSchema = z.enum(["declared", "shadow", "derived"]);
const ControlPlaneChecksModeSchema = z.enum(["off", "report", "enforce"]);

const ControlPlaneChecksSchema = z
  .object({
    mode: ControlPlaneChecksModeSchema.default("off"),
    commands_by_component: z.record(z.string().min(1)).default({}),
    max_components_for_scoped: z.number().int().positive().default(3),
    fallback_command: z.string().min(1).optional(),
  })
  .strict();

const ControlPlaneSurfacePatternsSchema = z
  .object({
    contract: z.array(z.string().min(1)).optional(),
    config: z.array(z.string().min(1)).optional(),
    migration: z.array(z.string().min(1)).optional(),
    "public-entrypoint": z.array(z.string().min(1)).optional(),
  })
  .strict();

const ControlPlaneSurfaceLocksSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

const ControlPlaneSchema = z
  .object({
    enabled: z.boolean().default(false),
    component_resource_prefix: z.string().min(1).default("component:"),
    fallback_resource: z.string().min(1).default("repo-root"),
    resources_mode: ControlPlaneResourcesModeSchema.default("prefer-derived"),
    scope_mode: ControlPlaneScopeModeSchema.default("enforce"),
    lock_mode: ControlPlaneLockModeSchema.default("declared"),
    checks: ControlPlaneChecksSchema.default({}),
    surface_patterns: ControlPlaneSurfacePatternsSchema.default({}),
    surface_locks: ControlPlaneSurfaceLocksSchema.default({}),
  })
  .strict();

const PlannerSchema = z
  .object({
    provider: LlmProviderSchema.default("codex"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    anthropic_api_key: z.string().min(1).optional(),
    anthropic_base_url: z.string().min(1).optional(),
  })
  .strict();

const WorkerSchema = z
  .object({
    model: z.string().min(1),
    // Optional Codex config field (written to config.toml as model_reasoning_effort).
    // This is intentionally permissive because support depends on the model family.
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    max_retries: z.number().int().nonnegative().optional(),
    checkpoint_commits: z.boolean().default(true),
    log_codex_prompts: z.boolean().default(false),
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
    anthropic_api_key: z.string().min(1).optional(),
    anthropic_base_url: z.string().min(1).optional(),
  })
  .strict();

const ArchitectureValidatorSchema = ValidatorSchema.extend({
  docs_glob: z.string().min(1).default(".mycelium/planning/**/architecture*.md"),
  fail_if_docs_missing: z.boolean().default(false),
}).strict();

const DoctorValidatorSchema = ValidatorSchema.extend({
  run_every_n_tasks: z.number().int().positive().default(10),
}).strict();

const DoctorCanaryModeSchema = z.enum(["off", "env"]);

const DoctorCanarySchema = z
  .object({
    mode: DoctorCanaryModeSchema.default("env"),
    env_var: z.string().min(1).default("ORCH_CANARY"),
    warn_on_unexpected_pass: z.boolean().default(true),
  })
  .strict();

const LogSummariesSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: LlmProviderSchema.default("openai"),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    anthropic_api_key: z.string().min(1).optional(),
    anthropic_base_url: z.string().min(1).optional(),
  })
  .strict();

const UiSchema = z
  .object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(0).default(8787),
    open_browser: z.boolean().default(true),
    refresh_ms: z.number().int().positive().default(2000),
  })
  .strict();

const BudgetsSchema = z
  .object({
    max_tokens_per_task: z.number().int().positive().optional(),
    max_cost_per_run: z.number().nonnegative().optional(),
    mode: z.enum(["warn", "block"]).default("warn"),
  })
  .strict();

const CleanupPolicySchema = z.enum(["never", "on_success"]);

const CleanupSchema = z
  .object({
    workspaces: CleanupPolicySchema.default("on_success"),
    containers: CleanupPolicySchema.default("on_success"),
  })
  .strict();

const DockerNetworkModeSchema = z.enum(["bridge", "none"]);

const DockerSchema = z
  .object({
    image: z.string().min(1).default("mycelium-worker:latest"),
    dockerfile: z.string().default("templates/Dockerfile"),
    build_context: z.string().default("."),
    user: z.string().min(1).default("worker"),
    network_mode: DockerNetworkModeSchema.default("bridge"),
    memory_mb: z.number().int().positive().optional(),
    cpu_quota: z.number().int().positive().optional(),
    pids_limit: z.number().int().positive().optional(),
  })
  .strict();

const ManifestEnforcementSchema = z.enum(["off", "warn", "block"]).default("warn");
const TaskFailurePolicySchema = z.enum(["fail_fast", "retry"]);

export const ProjectConfigSchema = z
  .object({
    repo_path: z.string().min(1),
    main_branch: z.string().min(1).default("development-codex"),
    task_branch_prefix: z.string().min(1).default("agent/"),

    // Where Mycelium stores planned task specs + manifests for the target repo.
    tasks_dir: z.string().min(1).default(".mycelium/tasks"),

    // Where Mycelium stores planning artifacts (implementation plan, sessions, etc.).
    planning_dir: z.string().min(1).default(".mycelium/planning"),

    max_parallel: z.number().int().positive().default(4),
    max_retries: z.number().int().nonnegative().default(20),
    timeout_minutes: z.number().int().positive().optional(),

    lint: z.string().min(1).optional(),
    lint_timeout: z.number().int().positive().optional(),
    doctor: z.string().min(1),
    doctor_timeout: z.number().int().positive().optional(),
    doctor_canary: DoctorCanarySchema.default({}),

    // Optional: run once in the worker container before Codex starts.
    // Example: ["npm ci", "npm test -- --help"]
    bootstrap: z.array(z.string()).default([]),

    test_paths: z.array(z.string()).default(DEFAULT_TEST_PATHS),

    resources: z.array(ResourceSchema).min(1),
    control_plane: ControlPlaneSchema.default({}),

    docker: DockerSchema.default({}),
    manifest_enforcement: ManifestEnforcementSchema.default("warn"),
    task_failure_policy: TaskFailurePolicySchema.default("retry"),

    planner: PlannerSchema,
    worker: WorkerSchema,

    test_validator: ValidatorSchema.optional(),
    style_validator: ValidatorSchema.optional(),
    architecture_validator: ArchitectureValidatorSchema.optional(),
    doctor_validator: DoctorValidatorSchema.optional(),
    log_summaries: LogSummariesSchema.optional(),
    ui: UiSchema.default({}),
    budgets: BudgetsSchema.default({}),
    cleanup: CleanupSchema.default({}),
  })
  .strict();

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type BudgetsConfig = z.infer<typeof BudgetsSchema>;
export type CleanupConfig = z.infer<typeof CleanupSchema>;
export type CleanupPolicy = z.infer<typeof CleanupPolicySchema>;
export type PlannerConfig = z.infer<typeof PlannerSchema>;
export type WorkerConfig = z.infer<typeof WorkerSchema>;
export type ValidatorConfig = z.infer<typeof ValidatorSchema>;
export type ArchitectureValidatorConfig = z.infer<typeof ArchitectureValidatorSchema>;
export type DoctorValidatorConfig = z.infer<typeof DoctorValidatorSchema>;
export type DoctorCanaryConfig = z.infer<typeof DoctorCanarySchema>;
export type DoctorCanaryMode = z.infer<typeof DoctorCanaryModeSchema>;
export type LogSummaryConfig = z.infer<typeof LogSummariesSchema>;
export type UiConfig = z.infer<typeof UiSchema>;
export type ValidatorMode = z.infer<typeof ValidatorModeSchema>;
export type ResourceConfig = z.infer<typeof ResourceSchema>;
export type ControlPlaneConfig = z.infer<typeof ControlPlaneSchema>;
export type ControlPlaneResourcesMode = z.infer<typeof ControlPlaneResourcesModeSchema>;
export type ControlPlaneScopeMode = z.infer<typeof ControlPlaneScopeModeSchema>;
export type ControlPlaneLockMode = z.infer<typeof ControlPlaneLockModeSchema>;
export type ControlPlaneChecksMode = z.infer<typeof ControlPlaneChecksModeSchema>;
export type ControlPlaneChecksConfig = z.infer<typeof ControlPlaneChecksSchema>;
export type ControlPlaneSurfacePatternsConfig = z.infer<typeof ControlPlaneSurfacePatternsSchema>;
export type ControlPlaneSurfaceLocksConfig = z.infer<typeof ControlPlaneSurfaceLocksSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type DockerNetworkMode = z.infer<typeof DockerNetworkModeSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ManifestEnforcementPolicy = z.infer<typeof ManifestEnforcementSchema>;
export type TaskFailurePolicy = z.infer<typeof TaskFailurePolicySchema>;
