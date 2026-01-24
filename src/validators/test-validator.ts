import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { z } from "zod";

import type { ValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import { validatorLogPath, validatorReportPath } from "../core/paths.js";
import { renderPromptTemplate } from "../core/prompts.js";
import { resolveTaskSpecPath } from "../core/task-layout.js";
import type { TaskSpec } from "../core/task-manifest.js";
import { writeJsonFile } from "../core/utils.js";
import type { LlmClient, LlmCompletionResult } from "../llm/client.js";
import { LlmError } from "../llm/client.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { OpenAiClient } from "../llm/openai.js";
import { listChangedFiles } from "../git/changes.js";
import { MockLlmClient, isMockLlmEnabled } from "../llm/mock.js";

// =============================================================================
// TYPES
// =============================================================================

type FileSample = {
  path: string;
  content: string;
  truncated: boolean;
};

type ValidationContext = {
  taskSpec: string;
  changedTests: FileSample[];
  testedCode: FileSample[];
  diffSummary: string;
  testOutput: string;
};

export type TestValidationReport = z.infer<typeof TestValidationSchema>;

export type TestValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  task: TaskSpec;
  taskSlug: string;
  workspacePath: string;
  taskLogsDir: string;
  mainBranch: string;
  config?: ValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const VALIDATOR_NAME = "test-validator";
const VALIDATOR_ID = "test";

const TestValidationSchema = z
  .object({
    pass: z.boolean(),
    summary: z.string(),
    concerns: z
      .array(
        z
          .object({
            file: z.string(),
            line: z.number().int().nonnegative().optional(),
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            suggested_fix: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    coverage_gaps: z.array(z.string()).default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  })
  .strict();

const TestValidatorJsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggested_fix: { type: "string" },
        },
        required: ["file", "issue", "severity"],
        additionalProperties: false,
      },
      default: [],
    },
    coverage_gaps: { type: "array", items: { type: "string" }, default: [] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["pass", "summary", "concerns", "coverage_gaps", "confidence"],
  additionalProperties: false,
} as const;

const TEST_SNIPPET_LIMIT = 4_000;
const CODE_SNIPPET_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 4_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const TEST_OUTPUT_LIMIT = 4_000;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runTestValidator(
  args: TestValidatorArgs,
): Promise<TestValidationReport | null> {
  const cfg = args.config;
  if (!cfg || cfg.enabled === false) {
    return null;
  }

  const validatorLog =
    args.logger ??
    new JsonlLogger(validatorLogPath(args.projectName, args.runId, VALIDATOR_NAME), {
      runId: args.runId,
    });
  const shouldCloseLog = !args.logger;

  logOrchestratorEvent(args.orchestratorLog, "validator.start", {
    validator: VALIDATOR_ID,
    taskId: args.task.manifest.id,
  });
  validatorLog.log({
    type: "validation.start",
    taskId: args.task.manifest.id,
    payload: { validator: VALIDATOR_ID },
  });

  try {
    const context = await buildValidationContext(args);

    if (context.changedTests.length === 0) {
      const result: TestValidationReport = {
        pass: true,
        summary: "No test changes detected; validation skipped.",
        concerns: [],
        coverage_gaps: [],
        confidence: "high",
      };

      await persistReport(args, context, result);
      validatorLog.log({
        type: "validation.skip",
        taskId: args.task.manifest.id,
        payload: { validator: VALIDATOR_ID },
      });
      logOrchestratorEvent(args.orchestratorLog, "validator.skip", {
        validator: VALIDATOR_ID,
        taskId: args.task.manifest.id,
      });
      return result;
    }

    const prompt = await renderPromptTemplate("test-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      task_id: args.task.manifest.id,
      task_name: args.task.manifest.name,
      task_spec: context.taskSpec,
      changed_tests: formatFilesForPrompt(context.changedTests),
      tested_code: formatFilesForPrompt(context.testedCode),
      diff_summary: context.diffSummary,
      test_output: context.testOutput,
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<TestValidationReport>(prompt, {
      schema: TestValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion);

    validatorLog.log({
      type: "validation.analysis",
      taskId: args.task.manifest.id,
      payload: {
        validator: VALIDATOR_ID,
        tests_checked: context.changedTests.length,
        concerns: result.concerns.length,
        coverage_gaps: result.coverage_gaps.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport(args, context, result, completion.finishReason);

    logOrchestratorEvent(args.orchestratorLog, result.pass ? "validator.pass" : "validator.fail", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
    });

    return result;
  } catch (err) {
    const message = formatError(err);
    validatorLog.log({
      type: "validation.error",
      taskId: args.task.manifest.id,
      payload: { validator: VALIDATOR_ID, message },
    });
    logOrchestratorEvent(args.orchestratorLog, "validator.error", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
      message,
    });
    return null;
  } finally {
    if (shouldCloseLog) {
      validatorLog.close();
    }
  }
}

// =============================================================================
// INTERNALS
// =============================================================================

async function buildValidationContext(args: TestValidatorArgs): Promise<ValidationContext> {
  const changedFiles = await listChangedFiles(args.workspacePath, args.mainBranch);
  const changedTests = changedFiles.filter(isTestFile);
  const testedCodePaths = uniq([
    ...changedFiles.filter((file) => !isTestFile(file)),
    ...(args.task.manifest.files.writes ?? []),
    ...(args.task.manifest.files.reads ?? []),
  ]);

  const taskSpecPath = resolveTaskSpecPath({
    tasksRoot: args.tasksRoot,
    stage: args.task.stage,
    taskDirName: args.task.taskDirName,
  });
  const [taskSpec, diffSummary, testOutput] = await Promise.all([
    readTaskSpec(taskSpecPath),
    readDiffSummary(args.workspacePath, args.mainBranch),
    readLatestDoctorOutput(args.taskLogsDir),
  ]);

  const [testSamples, codeSamples] = await Promise.all([
    readFileSamples(args.workspacePath, changedTests, TEST_SNIPPET_LIMIT),
    readFileSamples(args.workspacePath, testedCodePaths, CODE_SNIPPET_LIMIT),
  ]);

  return {
    taskSpec,
    changedTests: testSamples,
    testedCode: codeSamples,
    diffSummary,
    testOutput,
  };
}

function normalizeCompletion(
  completion: LlmCompletionResult<TestValidationReport>,
): TestValidationReport {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = TestValidationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new LlmError(`Test validator output failed schema validation: ${detail}`);
  }
  return parsed.data;
}

async function persistReport(
  args: TestValidatorArgs,
  context: ValidationContext,
  result: TestValidationReport,
  finishReason?: string | null,
): Promise<void> {
  const reportPath = validatorReportPath(
    args.projectName,
    args.runId,
    VALIDATOR_NAME,
    args.task.manifest.id,
    args.taskSlug,
  );

  await writeJsonFile(reportPath, {
    task_id: args.task.manifest.id,
    task_name: args.task.manifest.name,
    task_slug: args.taskSlug,
    validator: VALIDATOR_ID,
    run_id: args.runId,
    result,
    meta: {
      finish_reason: finishReason ?? null,
      changed_tests: context.changedTests.map((f) => f.path),
      tested_code: context.testedCode.map((f) => f.path),
      diff_summary: context.diffSummary,
      test_output: context.testOutput,
    },
  });
}

async function readFileSamples(
  baseDir: string,
  relativePaths: string[],
  limit: number,
): Promise<FileSample[]> {
  const unique = uniq(relativePaths);
  const samples: FileSample[] = [];

  for (const rel of unique) {
    const abs = path.join(baseDir, rel);
    const stat = await fse.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;

    const raw = await fse.readFile(abs, "utf8");
    const { text, truncated } = truncate(raw, limit);
    samples.push({ path: rel, content: text, truncated });
  }

  return samples;
}

async function readTaskSpec(specPath: string): Promise<string> {
  try {
    const raw = await fse.readFile(specPath, "utf8");
    return truncate(raw, TASK_SPEC_LIMIT).text;
  } catch {
    return "<task spec unavailable>";
  }
}

async function readDiffSummary(workspacePath: string, mainBranch: string): Promise<string> {
  const res = await execa("git", ["diff", "--stat", `${mainBranch}...HEAD`], {
    cwd: workspacePath,
    reject: false,
    stdio: "pipe",
  });

  if (res.exitCode !== 0) {
    return "<diff summary unavailable>";
  }

  const summary = res.stdout.trim();
  if (!summary) return "<no diff summary>";

  return truncate(summary, DIFF_SUMMARY_LIMIT).text;
}

async function readLatestDoctorOutput(taskLogsDir: string): Promise<string> {
  const exists = await fse.pathExists(taskLogsDir);
  if (!exists) return "<no doctor output recorded>";

  const entries = await fse.readdir(taskLogsDir);
  const doctorLogs = entries
    .filter((name) => name.startsWith("doctor-") && name.endsWith(".log"))
    .sort();

  if (doctorLogs.length === 0) {
    return "<no doctor output recorded>";
  }

  const latest = doctorLogs[doctorLogs.length - 1];
  const raw = await fse.readFile(path.join(taskLogsDir, latest), "utf8");
  return truncate(raw.trim(), TEST_OUTPUT_LIMIT).text || "<empty doctor log>";
}

function formatFilesForPrompt(files: FileSample[]): string {
  if (files.length === 0) {
    return "None";
  }

  return files
    .map((file) => {
      const suffix = file.truncated ? "\n[truncated]" : "";
      return `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`${suffix}`;
    })
    .join("\n\n");
}

function createValidatorClient(cfg: ValidatorConfig): LlmClient {
  if (isMockLlmEnabled() || cfg.provider === "mock") {
    return new MockLlmClient();
  }

  if (cfg.provider === "openai") {
    return new OpenAiClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
    });
  }

  if (cfg.provider === "anthropic") {
    return new AnthropicClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
      apiKey: cfg.anthropic_api_key,
      baseURL: cfg.anthropic_base_url,
    });
  }

  throw new Error(`Unsupported validator provider: ${cfg.provider}`);
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit)}\n... [truncated]`, truncated: true };
}

function isTestFile(file: string): boolean {
  const normalized = file.toLowerCase();
  const segments = normalized.split(/[\\/]/);

  if (segments.some((segment) => ["test", "tests", "__tests__"].includes(segment))) {
    return true;
  }

  return (
    /\.test\./.test(normalized) ||
    /\.spec\./.test(normalized) ||
    normalized.endsWith("_test.ts") ||
    normalized.endsWith("_test.js") ||
    normalized.endsWith("_spec.ts") ||
    normalized.endsWith("_spec.js")
  );
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values)).filter((v) => v.length > 0);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LlmError("Validator returned invalid JSON.", err);
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
