import path from "node:path";

import { execa } from "execa";
import fg from "fast-glob";
import fse from "fs-extra";
import { z } from "zod";

import type { ArchitectureValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import { taskBlastReportPath, validatorLogPath, validatorReportPath } from "../core/paths.js";
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

type ControlPlaneImpact = {
  touched_components: string[];
  impacted_components: string[];
  confidence?: string;
  widening_reasons: string[];
};

type ValidationContext = {
  taskSpec: string;
  architectureDocs: FileSample[];
  changedFiles: FileSample[];
  diffSummary: string;
  controlPlaneImpact: ControlPlaneImpact | null;
};

export type ArchitectureValidationReport = z.infer<typeof ArchitectureValidationSchema>;

export type ArchitectureValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  task: TaskSpec;
  taskSlug: string;
  workspacePath: string;
  mainBranch: string;
  config?: ArchitectureValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
};


// =============================================================================
// CONSTANTS
// =============================================================================

export const VALIDATOR_NAME = "architecture-validator";
export const VALIDATOR_ID = "architecture";

const DOC_SNIPPET_LIMIT = 4_000;
const FILE_SNIPPET_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 4_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const MAX_DOCS = 6;
const MAX_CHANGED_FILES = 12;

const ArchitectureValidationSchema = z
  .object({
    pass: z.boolean(),
    summary: z.string(),
    concerns: z
      .array(
        z
          .object({
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            evidence: z.string(),
            location: z.string().optional(),
            suggested_fix: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    recommendations: z
      .array(
        z
          .object({
            description: z.string(),
            impact: z.enum(["high", "medium", "low"]),
            action: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  })
  .strict();

const ArchitectureValidatorJsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
          location: { type: "string" },
          suggested_fix: { type: "string" },
        },
        required: ["issue", "severity", "evidence"],
        additionalProperties: false,
      },
      default: [],
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          action: { type: "string" },
        },
        required: ["description", "impact"],
        additionalProperties: false,
      },
      default: [],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["pass", "summary", "concerns", "recommendations", "confidence"],
  additionalProperties: false,
} as const;


// =============================================================================
// PUBLIC API
// =============================================================================

export async function runArchitectureValidator(
  args: ArchitectureValidatorArgs,
): Promise<ArchitectureValidationReport | null> {
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
    const context = await buildValidationContext(args, cfg);

    if (context.changedFiles.length === 0) {
      const result: ArchitectureValidationReport = {
        pass: true,
        summary: "No changed files detected; validation skipped.",
        concerns: [],
        recommendations: [],
        confidence: "high",
      };

      await persistReport(args, cfg, context, result);
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

    if (context.architectureDocs.length === 0) {
      if (!cfg.fail_if_docs_missing) {
        const result: ArchitectureValidationReport = {
          pass: true,
          summary: "No architecture docs found; validation skipped.",
          concerns: [],
          recommendations: [],
          confidence: "high",
        };

        await persistReport(args, cfg, context, result);
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

      const result: ArchitectureValidationReport = {
        pass: false,
        summary: "No architecture docs found; validation failed.",
        concerns: [
          {
            issue: "Architecture docs missing for validation.",
            severity: "high",
            evidence: `No docs matched glob: ${cfg.docs_glob}`,
            location: cfg.docs_glob,
            suggested_fix: "Add architecture docs or update docs_glob.",
          },
        ],
        recommendations: [
          {
            description: "Add architecture docs or update docs_glob to point to them.",
            impact: "high",
            action: `Provide docs matching: ${cfg.docs_glob}`,
          },
        ],
        confidence: "high",
      };

      validatorLog.log({
        type: "validation.analysis",
        taskId: args.task.manifest.id,
        payload: {
          validator: VALIDATOR_ID,
          docs_checked: 0,
          files_checked: context.changedFiles.length,
          concerns: result.concerns.length,
          recommendations: result.recommendations.length,
          confidence: result.confidence,
        },
      });

      await persistReport(args, cfg, context, result);
      logOrchestratorEvent(args.orchestratorLog, "validator.fail", {
        validator: VALIDATOR_ID,
        taskId: args.task.manifest.id,
      });
      return result;
    }

    const prompt = await renderPromptTemplate("architecture-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      task_id: args.task.manifest.id,
      task_name: args.task.manifest.name,
      task_spec: context.taskSpec,
      architecture_docs: formatFilesForPrompt(context.architectureDocs),
      changed_files: formatFilesForPrompt(context.changedFiles),
      diff_summary: context.diffSummary,
      control_plane_impact: formatControlPlaneImpactForPrompt(context.controlPlaneImpact),
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<ArchitectureValidationReport>(prompt, {
      schema: ArchitectureValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion);

    validatorLog.log({
      type: "validation.analysis",
      taskId: args.task.manifest.id,
      payload: {
        validator: VALIDATOR_ID,
        docs_checked: context.architectureDocs.length,
        files_checked: context.changedFiles.length,
        concerns: result.concerns.length,
        recommendations: result.recommendations.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport(args, cfg, context, result, completion.finishReason);

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

async function buildValidationContext(
  args: ArchitectureValidatorArgs,
  cfg: ArchitectureValidatorConfig,
): Promise<ValidationContext> {
  const taskSpecPath = resolveTaskSpecPath({
    tasksRoot: args.tasksRoot,
    stage: args.task.stage,
    taskDirName: args.task.taskDirName,
  });
  const [taskSpec, diffSummary, changedFiles, architectureDocs, controlPlaneImpact] =
    await Promise.all([
      readTaskSpec(taskSpecPath),
      readDiffSummary(args.workspacePath, args.mainBranch),
      readChangedFileSamples(args.workspacePath, args.mainBranch),
      readArchitectureDocs(args.repoPath, cfg.docs_glob),
      readControlPlaneImpact(args.repoPath, args.runId, args.task.manifest.id),
    ]);

  return {
    taskSpec,
    architectureDocs,
    changedFiles,
    diffSummary,
    controlPlaneImpact,
  };
}

function normalizeCompletion(
  completion: LlmCompletionResult<ArchitectureValidationReport>,
): ArchitectureValidationReport {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = ArchitectureValidationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new LlmError(`Architecture validator output failed schema validation: ${detail}`);
  }
  return parsed.data;
}

async function persistReport(
  args: ArchitectureValidatorArgs,
  cfg: ArchitectureValidatorConfig,
  context: ValidationContext,
  result: ArchitectureValidationReport,
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
      docs_glob: cfg.docs_glob,
      fail_if_docs_missing: cfg.fail_if_docs_missing ?? false,
      docs: context.architectureDocs.map((f) => f.path),
      changed_files: context.changedFiles.map((f) => f.path),
      diff_summary: context.diffSummary,
      control_plane: context.controlPlaneImpact,
      finish_reason: finishReason ?? null,
    },
  });
}

async function readChangedFileSamples(
  workspacePath: string,
  mainBranch: string,
): Promise<FileSample[]> {
  const changedFiles = await listChangedFiles(workspacePath, mainBranch);
  return readFileSamples(workspacePath, changedFiles, FILE_SNIPPET_LIMIT, MAX_CHANGED_FILES);
}

async function readArchitectureDocs(
  repoPath: string,
  docsGlob: string,
): Promise<FileSample[]> {
  const matches = await fg(docsGlob, {
    cwd: repoPath,
    dot: true,
    onlyFiles: true,
  });
  const normalized = matches.map((docPath) => normalizePath(docPath)).sort();
  return readFileSamples(repoPath, normalized, DOC_SNIPPET_LIMIT, MAX_DOCS);
}

async function readFileSamples(
  baseDir: string,
  relativePaths: string[],
  limit: number,
  maxFiles: number,
): Promise<FileSample[]> {
  const unique = uniq(relativePaths).slice(0, maxFiles);
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

async function readControlPlaneImpact(
  repoPath: string,
  runId: string,
  taskId: string,
): Promise<ControlPlaneImpact | null> {
  const reportPath = taskBlastReportPath(repoPath, runId, taskId);
  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const touched = Array.isArray((raw as { touched_components?: unknown }).touched_components)
    ? ((raw as { touched_components?: string[] }).touched_components ?? [])
    : [];
  const impacted = Array.isArray((raw as { impacted_components?: unknown }).impacted_components)
    ? ((raw as { impacted_components?: string[] }).impacted_components ?? [])
    : [];
  const confidence =
    typeof (raw as { confidence?: unknown }).confidence === "string"
      ? (raw as { confidence?: string }).confidence
      : undefined;
  const widening =
    Array.isArray((raw as { widening_reasons?: unknown }).widening_reasons)
      ? ((raw as { widening_reasons?: string[] }).widening_reasons ?? [])
      : [];

  return {
    touched_components: touched,
    impacted_components: impacted,
    confidence,
    widening_reasons: widening,
  };
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

function formatControlPlaneImpactForPrompt(impact: ControlPlaneImpact | null): string {
  if (!impact) {
    return "Unavailable";
  }

  const touched =
    impact.touched_components.length > 0
      ? impact.touched_components.join(", ")
      : "None";
  const impacted =
    impact.impacted_components.length > 0
      ? impact.impacted_components.join(", ")
      : "None";
  const parts = [
    `Touched components (${impact.touched_components.length}): ${touched}`,
    `Impacted components (${impact.impacted_components.length}): ${impacted}`,
  ];

  if (impact.confidence) {
    parts.push(`Blast confidence: ${impact.confidence}`);
  }

  if (impact.widening_reasons.length > 0) {
    parts.push(`Widening reasons: ${impact.widening_reasons.join(", ")}`);
  }

  return parts.join("\n");
}

function createValidatorClient(cfg: ArchitectureValidatorConfig): LlmClient {
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

function uniq(values: string[]): string[] {
  return Array.from(new Set(values)).filter((v) => v.length > 0);
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
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
