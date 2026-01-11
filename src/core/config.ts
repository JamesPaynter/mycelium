import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";

const ResourceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  paths: z.array(z.string()).min(1)
});

const PlannerSchema = z.object({
  provider: z.enum(["openai", "anthropic", "codex"]).default("codex"),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional()
});

const WorkerSchema = z.object({
  model: z.string().min(1),
  max_retries: z.number().int().positive().optional()
});

const ValidatorSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["openai", "anthropic", "codex"]).default("openai"),
  model: z.string().min(1)
});

const DockerSchema = z.object({
  image: z.string().min(1).default("task-orchestrator-worker:latest"),
  dockerfile: z.string().default("templates/worker.Dockerfile"),
  build_context: z.string().default(".")
});

export const ProjectConfigSchema = z.object({
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
  doctor_validator: ValidatorSchema.optional()
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, varName: string) => {
      const v = process.env[varName];
      if (v === undefined) {
        throw new ConfigError(`Environment variable ${varName} is not set but is referenced in config.`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map(expandEnv);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v);
    }
    return out;
  }
  return value;
}

export function loadProjectConfig(configPath: string): ProjectConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Project config not found at: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML config: ${configPath}`, err);
  }

  const expanded = expandEnv(doc);

  const parsed = ProjectConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    throw new ConfigError(`Invalid project config: ${configPath}\n${parsed.error.toString()}`);
  }

  // Normalize repo_path and docker paths to absolute.
  const cfg = parsed.data;
  const repoPathAbs = path.resolve(cfg.repo_path);
  const dockerfileAbs = path.resolve(cfg.docker.dockerfile);
  const buildContextAbs = path.resolve(cfg.docker.build_context);

  return {
    ...cfg,
    repo_path: repoPathAbs,
    docker: {
      ...cfg.docker,
      dockerfile: dockerfileAbs,
      build_context: buildContextAbs
    }
  };
}
