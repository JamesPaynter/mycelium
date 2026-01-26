import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import { execa } from "execa";
import fse from "fs-extra";
import { z } from "zod";

import { ensureCodexAuthForHome } from "./codexAuth.js";
import type { PlannerConfig, ProjectConfig, ResourceConfig } from "./config.js";
import { JsonlLogger } from "./logger.js";
import type { PathsContext } from "./paths.js";
import { plannerHomeDir } from "./paths.js";
import { renderPromptTemplate } from "./prompts.js";
import {
  TaskManifestWithSpecSchema,
  formatManifestIssues,
  normalizeTaskManifest,
  type TaskWithSpec,
  validateResourceLocks,
} from "./task-manifest.js";
import { normalizeTestPaths } from "./test-paths.js";
import { writeTasksToDirectory } from "./task-writer.js";
import { ensureDir, readTextFile } from "./utils.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { OpenAiClient } from "../llm/openai.js";
import {
  LlmClient,
  LlmError,
  type LlmCompletionOptions,
  type LlmCompletionResult,
} from "../llm/client.js";
import { isMockLlmEnabled, MockLlmClient } from "../llm/mock.js";

export type PlanResult = {
  tasks: TaskWithSpec[];
  outputDir: string;
  planIndexPath?: string;
};

type PlannerOutput = z.infer<typeof PlannerResponseSchema>;

const PlannerOutputJsonSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          estimated_minutes: { type: "integer" },
          dependencies: { type: "array", items: { type: "string" } },
          locks: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          files: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          test_paths: { type: "array", items: { type: "string" } },
          tdd_mode: { type: "string", enum: ["off", "strict"] },
          affected_tests: { type: "array", items: { type: "string" } },
          verify: {
            type: "object",
            properties: {
              doctor: { type: "string" },
              fast: { type: "string" },
              lint: { type: "string" },
            },
            required: ["doctor"],
            additionalProperties: false,
          },
          spec: { type: "string" },
        },
        required: [
          "id",
          "name",
          "description",
          "estimated_minutes",
          "dependencies",
          "locks",
          "files",
          "test_paths",
          "tdd_mode",
          "affected_tests",
          "verify",
          "spec",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
} as const;

const PlannerResponseSchema = z.object({
  tasks: z.array(TaskManifestWithSpecSchema).min(1, "Planner must return at least one task."),
});

export async function planFromImplementationPlan(args: {
  projectName: string;
  config: ProjectConfig;
  inputPath: string;
  outputDir: string;
  dryRun?: boolean;
  log?: JsonlLogger;
  paths?: PathsContext;
}): Promise<PlanResult> {
  const { projectName, config, outputDir, dryRun } = args;
  const repoPath = config.repo_path;
  const outputDirAbs = path.isAbsolute(outputDir) ? outputDir : path.join(repoPath, outputDir);
  const inputAbs = path.isAbsolute(args.inputPath)
    ? args.inputPath
    : path.join(repoPath, args.inputPath);
  const log = args.log;

  try {
    const implementationPlan = await readImplementationPlan(inputAbs);
    const codebaseTree = await readCodebaseTree(repoPath);
    const resourcesBlock = formatResources(config.resources);

    const prompt = await renderPromptTemplate("planner", {
      project_name: projectName,
      repo_path: repoPath,
      resources: resourcesBlock,
      doctor_command: config.doctor,
      lint_command: config.lint ?? "",
      implementation_plan: implementationPlan,
      codebase_tree: codebaseTree,
    });

    log?.log({ type: "planner.start", payload: { project: projectName, input: inputAbs } });

    const client = createPlannerClient(config.planner, projectName, repoPath, log, args.paths);
    const completion = await client.complete<PlannerOutput>(prompt, {
      schema: PlannerOutputJsonSchema,
      temperature: config.planner.temperature,
      timeoutMs: secondsToMs(config.planner.timeout_seconds),
    });

    log?.log({ type: "planner.llm.complete", payload: { finish_reason: completion.finishReason } });

    const tasks = parsePlannerOutput(
      completion,
      config.resources.map((r) => r.name),
    );

    log?.log({ type: "planner.validate.complete", payload: { task_count: tasks.length } });

    if (dryRun) {
      return { tasks, outputDir: outputDirAbs };
    }

    const writeResult = await writeTasksToDirectory({
      tasks,
      outputDir: outputDirAbs,
      project: projectName,
      inputPath: inputAbs,
    });

    log?.log({
      type: "planner.write.complete",
      payload: { task_count: tasks.length, output_dir: outputDirAbs },
    });

    return {
      tasks,
      outputDir: outputDirAbs,
      planIndexPath: writeResult.planIndexPath,
    };
  } catch (err) {
    log?.log({ type: "planner.error", payload: { message: formatError(err) } });
    throw err;
  }
}

function parsePlannerOutput(
  completion: LlmCompletionResult<PlannerOutput>,
  resources: string[],
): TaskWithSpec[] {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = PlannerResponseSchema.safeParse(raw);

  if (!parsed.success) {
    const detail = formatManifestIssues(parsed.error.issues)
      .map((i) => `- ${i}`)
      .join("\n");
    throw new Error(`Planner output failed schema validation:\n${detail}`);
  }

  const normalized = parsed.data.tasks.map((task) => {
    const { spec, ...manifestFields } = task;
    const manifest = normalizeTaskManifest(manifestFields);
    return { ...manifest, spec: spec.trim() };
  });

  const validationIssues = validatePlannerTasks(normalized, resources);
  if (validationIssues.length > 0) {
    const detail = validationIssues.map((i) => `- ${i}`).join("\n");
    throw new Error(`Planner output failed validation:\n${detail}`);
  }

  return normalized;
}

function validatePlannerTasks(tasks: TaskWithSpec[], resources: string[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const allIds = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    const taskIssues: string[] = [];

    if (seenIds.has(task.id)) {
      taskIssues.push(`duplicate id "${task.id}"`);
    } else {
      seenIds.add(task.id);
    }

    if (!isKebabCase(task.name)) {
      taskIssues.push(`name must be kebab-case (got "${task.name}")`);
    }

    const lockIssues = validateResourceLocks(task, resources);
    if (lockIssues.length > 0) taskIssues.push(...lockIssues);

    if (!task.verify.doctor.trim()) {
      taskIssues.push("verify.doctor is required");
    }
    if (task.tdd_mode === "strict") {
      const testPaths = normalizeTestPaths(task.test_paths);
      if (testPaths.length === 0) {
        taskIssues.push("test_paths must be provided when tdd_mode is strict");
      }
      if (task.affected_tests.length === 0) {
        taskIssues.push("affected_tests must be provided when tdd_mode is strict");
      }
      if (!task.verify.fast?.trim()) {
        taskIssues.push("verify.fast is required when tdd_mode is strict");
      }
    }

    const deps = task.dependencies ?? [];
    const missingDeps = deps.filter((dep) => !allIds.has(dep));
    if (missingDeps.length > 0) {
      taskIssues.push(`dependencies reference unknown ids: ${missingDeps.join(", ")}`);
    }
    if (deps.includes(task.id)) {
      taskIssues.push("dependencies cannot include the task itself");
    }

    if (taskIssues.length > 0) {
      issues.push(`Task ${task.id}: ${taskIssues.join("; ")}`);
    }
  }

  return issues;
}

function isKebabCase(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function formatResources(resources: ResourceConfig[]): string {
  return resources
    .map((resource) => {
      const desc = resource.description ? `: ${resource.description}` : "";
      return `- **${resource.name}**${desc}\n  - Paths: ${resource.paths.join(", ")}`;
    })
    .join("\n");
}

async function readImplementationPlan(inputPath: string): Promise<string> {
  const exists = await fse.pathExists(inputPath);
  if (!exists) {
    throw new Error(`Implementation plan not found at ${inputPath}`);
  }
  return readTextFile(inputPath);
}

async function readCodebaseTree(repoPath: string): Promise<string> {
  try {
    const tree = await execa("git", ["ls-files"], { cwd: repoPath, stdio: "pipe" });
    return tree.stdout.trim();
  } catch (err) {
    throw new Error(`Failed to read git tree for ${repoPath}: ${formatError(err)}`);
  }
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new LlmError("Planner returned non-JSON output.", err);
  }
}

function secondsToMs(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return value * 1000;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createPlannerClient(
  cfg: PlannerConfig,
  projectName: string,
  repoPath: string,
  log?: JsonlLogger,
  paths?: PathsContext,
): LlmClient {
  if (isMockLlmEnabled() || cfg.provider === "mock") {
    return new MockLlmClient();
  }

  if (cfg.provider === "openai") {
    return new OpenAiClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
    });
  }

  if (cfg.provider === "anthropic") {
    return new AnthropicClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
      apiKey: cfg.anthropic_api_key,
      baseURL: cfg.anthropic_base_url,
    });
  }

  if (cfg.provider === "codex") {
    const codexHome = plannerHomeDir(projectName, paths);
    return new CodexPlannerClient({
      model: cfg.model,
      codexHome,
      workingDirectory: repoPath,
      log,
    });
  }

  throw new Error(`Unsupported planner provider: ${cfg.provider}`);
}

class CodexPlannerClient implements LlmClient {
  private readonly model: string;
  private readonly codexHome: string;
  private readonly workingDirectory: string;
  private readonly log?: JsonlLogger;

  constructor(args: {
    model: string;
    codexHome: string;
    workingDirectory: string;
    log?: JsonlLogger;
  }) {
    this.model = args.model;
    this.codexHome = args.codexHome;
    this.workingDirectory = args.workingDirectory;
    this.log = args.log;
  }

  async complete<TParsed = unknown>(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<LlmCompletionResult<TParsed>> {
    const codexHome = this.codexHome;
    await ensureDir(codexHome);
    await writePlannerCodexConfig(path.join(codexHome, "config.toml"), this.model);

    // If the user authenticated via `codex login`, auth material typically lives under
    // ~/.codex/auth.json (file-based storage). Because we run with a custom CODEX_HOME,
    // we copy that auth file into this planner CODEX_HOME when no API key is provided.
    const auth = await ensureCodexAuthForHome(codexHome);
    this.log?.log({
      type: "codex.auth",
      mode: auth.mode,
      source: auth.mode === "env" ? auth.var : "auth.json",
    });

    const env: Record<string, string> = { CODEX_HOME: codexHome };
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    if (process.env.OPENAI_ORGANIZATION) env.OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION;

    const codex = new Codex({ env });
    const thread = codex.startThread({ workingDirectory: this.workingDirectory });

    const result = await thread.run(prompt, { outputSchema: options.schema as any });
    const text = result.finalResponse ?? "";
    const parsed = options.schema ? parseJson<TParsed>(text) : undefined;

    return { text, parsed, finishReason: null };
  }
}

async function writePlannerCodexConfig(filePath: string, model: string): Promise<void> {
  const content = [
    `model = "${model}"`,
    // "never" means no approval prompts (the planner runs unattended; sandbox is read-only).
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "",
  ].join("\n");
  await ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
