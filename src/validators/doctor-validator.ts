import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { z } from "zod";

import type { DoctorValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import { runLogsDir, validatorLogPath, validatorsLogsDir } from "../core/paths.js";
import { renderPromptTemplate } from "../core/prompts.js";
import { writeJsonFile } from "../core/utils.js";
import type { LlmClient, LlmCompletionResult } from "../llm/client.js";
import { LlmError } from "../llm/client.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { OpenAiClient } from "../llm/openai.js";

// =============================================================================
// TYPES
// =============================================================================

type DoctorRunSample = {
  taskId: string;
  taskSlug: string;
  attempt: number;
  status?: "pass" | "fail";
  exitCode?: number;
  summary?: string;
  logPath: string;
  log: string;
  truncated: boolean;
};

export type DoctorCanaryResult =
  | { status: "expected_fail"; exitCode: number; output: string }
  | { status: "unexpected_pass"; exitCode: number; output: string }
  | { status: "skipped"; reason: string };

type ValidationContext = {
  doctorCommand: string;
  diffSummary: string;
  doctorRuns: DoctorRunSample[];
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
};

export type DoctorValidationReport = z.infer<typeof DoctorValidationSchema>;

export type DoctorValidatorTrigger =
  | "cadence"
  | "integration_doctor_failed"
  | "doctor_canary_failed"
  | "manual";

export type DoctorValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  mainBranch: string;
  doctorCommand: string;
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
  config?: DoctorValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const VALIDATOR_NAME = "doctor-validator";
const VALIDATOR_ID = "doctor";

const DOCTOR_RUN_SAMPLE_LIMIT = 6;
const DOCTOR_LOG_CHAR_LIMIT = 2_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const INTEGRATION_OUTPUT_LIMIT = 3_000;
const DOCTOR_CANARY_LOG_LIMIT = 2_000;

const DoctorValidationSchema = z
  .object({
    effective: z.boolean(),
    coverage_assessment: z.enum(["good", "partial", "poor"]),
    concerns: z
      .array(
        z
          .object({
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            evidence: z.string(),
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

const DoctorValidatorJsonSchema = {
  type: "object",
  properties: {
    effective: { type: "boolean" },
    coverage_assessment: { type: "string", enum: ["good", "partial", "poor"] },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
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
  required: ["effective", "coverage_assessment", "concerns", "recommendations", "confidence"],
  additionalProperties: false,
} as const;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runDoctorValidator(
  args: DoctorValidatorArgs,
): Promise<DoctorValidationReport | null> {
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
    trigger: args.trigger,
  });
  validatorLog.log({
    type: "validation.start",
    payload: { validator: VALIDATOR_ID, trigger: args.trigger },
  });

  try {
    const context = await buildValidationContext(args);

    const prompt = await renderPromptTemplate("doctor-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      doctor_command: args.doctorCommand,
      recent_doctor_runs: formatDoctorRunsForPrompt(context.doctorRuns),
      recent_changes: context.diffSummary,
      doctor_expectations: buildDoctorExpectations(context),
      doctor_canary: formatDoctorCanaryForPrompt(context.doctorCanary),
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<DoctorValidationReport>(prompt, {
      schema: DoctorValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion);
    const stats = computeRunStats(context.doctorRuns);

    validatorLog.log({
      type: "validation.analysis",
      payload: {
        validator: VALIDATOR_ID,
        trigger: args.trigger,
        doctor_runs: context.doctorRuns.length,
        concerns: result.concerns.length,
        recommendations: result.recommendations.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport(args, context, result, completion.finishReason, stats);

    logOrchestratorEvent(
      args.orchestratorLog,
      result.effective ? "validator.pass" : "validator.fail",
      {
        validator: VALIDATOR_ID,
        trigger: args.trigger,
      },
    );

    return result;
  } catch (err) {
    const message = formatError(err);
    validatorLog.log({
      type: "validation.error",
      payload: { validator: VALIDATOR_ID, trigger: args.trigger, message },
    });
    logOrchestratorEvent(args.orchestratorLog, "validator.error", {
      validator: VALIDATOR_ID,
      trigger: args.trigger,
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

async function buildValidationContext(args: DoctorValidatorArgs): Promise<ValidationContext> {
  const runLogs = runLogsDir(args.projectName, args.runId);

  const [diffSummary, doctorRuns] = await Promise.all([
    readDiffSummary(args.repoPath, args.mainBranch),
    readDoctorRuns(runLogs),
  ]);

  const integrationDoctorOutput = args.integrationDoctorOutput
    ? truncate(args.integrationDoctorOutput, INTEGRATION_OUTPUT_LIMIT).text
    : undefined;
  const doctorCanary = normalizeDoctorCanary(args.doctorCanary);

  return {
    doctorCommand: args.doctorCommand,
    diffSummary,
    doctorRuns,
    trigger: args.trigger,
    triggerNotes: args.triggerNotes,
    integrationDoctorOutput,
    doctorCanary,
  };
}

async function readDoctorRuns(runLogs: string): Promise<DoctorRunSample[]> {
  const tasksDir = path.join(runLogs, "tasks");
  const exists = await fse.pathExists(tasksDir);
  if (!exists) return [];

  const taskDirs = (await fse.readdir(tasksDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );

  const allRuns: Array<DoctorRunSample & { mtimeMs: number }> = [];
  for (const dir of taskDirs) {
    const taskDir = path.join(tasksDir, dir.name);
    const { taskId, taskSlug } = parseTaskDirName(dir.name);
    const attemptStatuses = await readDoctorAttemptStatuses(path.join(taskDir, "events.jsonl"));

    const doctorLogs = (await fse.readdir(taskDir)).filter((file) =>
      /^doctor-\d+\.log$/i.test(file),
    );
    for (const logName of doctorLogs) {
      const attempt = parseAttempt(logName);
      if (attempt === null) continue;

      const fullPath = path.join(taskDir, logName);
      const stat = await fse.stat(fullPath).catch(() => null);
      if (!stat) continue;

      const { text, truncated } = await readFileTruncated(fullPath, DOCTOR_LOG_CHAR_LIMIT);
      const status = attemptStatuses.get(attempt);

      allRuns.push({
        taskId,
        taskSlug,
        attempt,
        status: status?.status,
        exitCode: status?.exitCode,
        summary: status?.summary,
        logPath: path.relative(runLogs, fullPath),
        log: text,
        truncated,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return allRuns
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, DOCTOR_RUN_SAMPLE_LIMIT)
    .map(({ mtimeMs: _mtimeMs, ...rest }) => rest);
}

async function readDoctorAttemptStatuses(
  eventsPath: string,
): Promise<Map<number, { status: "pass" | "fail"; exitCode?: number; summary?: string }>> {
  const statuses = new Map<number, { status: "pass" | "fail"; exitCode?: number; summary?: string }>();
  const exists = await fse.pathExists(eventsPath);
  if (!exists) return statuses;

  const lines = (await fse.readFile(eventsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = safeParseJson(line);
    if (!parsed) continue;

    const attempt = typeof parsed.attempt === "number" ? parsed.attempt : null;
    if (!attempt) continue;

    if (parsed.type === "doctor.pass") {
      statuses.set(attempt, { status: "pass" });
      continue;
    }

    if (parsed.type === "doctor.fail") {
      const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      const exitCode =
        payload && typeof (payload as { exit_code?: unknown }).exit_code === "number"
          ? (payload as { exit_code: number }).exit_code
          : undefined;
      const summary =
        payload && typeof (payload as { summary?: unknown }).summary === "string"
          ? (payload as { summary: string }).summary
          : undefined;
      statuses.set(attempt, { status: "fail", exitCode, summary });
    }
  }

  return statuses;
}

async function readDiffSummary(repoPath: string, mainBranch: string): Promise<string> {
  const res = await execa("git", ["diff", "--stat", `${mainBranch}...HEAD`], {
    cwd: repoPath,
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

function formatDoctorRunsForPrompt(runs: DoctorRunSample[]): string {
  if (runs.length === 0) {
    return "No doctor runs recorded for this run.";
  }

  return runs
    .map((run) => {
      const statusLabel =
        run.status === undefined
          ? "status: unknown"
          : run.status === "pass"
            ? "status: pass"
            : `status: fail${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}`;

      const header = [`Task ${run.taskId}`, `attempt ${run.attempt}`, statusLabel].join(" — ");
      const summaryLine = run.summary ? `Summary: ${run.summary}` : null;
      const pathLine = run.logPath ? `Log: ${run.logPath}` : null;

      return [header, summaryLine, pathLine, "```", run.log, "```", run.truncated ? "[truncated]" : ""]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function buildDoctorExpectations(context: ValidationContext): string {
  const stats = computeRunStats(context.doctorRuns);
  const lines = [
    `Trigger: ${context.trigger}`,
    `Doctor runs observed: ${stats.total} (pass: ${stats.passes}, fail: ${stats.failures})`,
  ];

  if (context.triggerNotes) {
    lines.push(`Notes: ${context.triggerNotes}`);
  }
  if (context.integrationDoctorOutput) {
    lines.push("Integration doctor output (most recent):", context.integrationDoctorOutput);
  }
  lines.push(formatDoctorCanaryForPrompt(context.doctorCanary));

  return lines.join("\n");
}

function computeRunStats(runs: DoctorRunSample[]): { total: number; passes: number; failures: number } {
  return runs.reduce(
    (acc, run) => {
      acc.total += 1;
      if (run.status === "pass") acc.passes += 1;
      if (run.status === "fail") acc.failures += 1;
      return acc;
    },
    { total: 0, passes: 0, failures: 0 },
  );
}

function normalizeCompletion(
  completion: LlmCompletionResult<DoctorValidationReport>,
): DoctorValidationReport {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = DoctorValidationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new LlmError(`Doctor validator output failed schema validation: ${detail}`);
  }
  return parsed.data;
}

async function persistReport(
  args: DoctorValidatorArgs,
  context: ValidationContext,
  result: DoctorValidationReport,
  finishReason: string | null | undefined,
  stats: { total: number; passes: number; failures: number },
): Promise<void> {
  const label = `${context.trigger}-${Date.now()}`;
  const reportPath = path.join(
    validatorsLogsDir(args.projectName, args.runId),
    VALIDATOR_NAME,
    `${label}.json`,
  );

  await writeJsonFile(reportPath, {
    project: args.projectName,
    run_id: args.runId,
    validator: VALIDATOR_ID,
    trigger: context.trigger,
    result,
    meta: {
      doctor_command: context.doctorCommand,
      diff_summary: context.diffSummary,
      doctor_runs: context.doctorRuns,
      stats,
      integration_doctor_output: context.integrationDoctorOutput ?? null,
      trigger_notes: context.triggerNotes ?? null,
      finish_reason: finishReason ?? null,
      doctor_canary: context.doctorCanary ?? null,
    },
  });
}

async function readFileTruncated(
  filePath: string,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const exists = await fse.pathExists(filePath);
  if (!exists) {
    return { text: "<log not found>", truncated: false };
  }

  const raw = await fse.readFile(filePath, "utf8");
  return truncate(raw.trim(), limit);
}

function parseAttempt(fileName: string): number | null {
  const match = fileName.match(/^doctor-(\d+)\.log$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseTaskDirName(name: string): { taskId: string; taskSlug: string } {
  const dashIndex = name.indexOf("-");
  if (dashIndex === -1) {
    return { taskId: name, taskSlug: name };
  }

  const taskId = name.slice(0, dashIndex);
  const taskSlug = name.slice(dashIndex + 1) || name;
  return { taskId, taskSlug };
}

function createValidatorClient(cfg: DoctorValidatorConfig): LlmClient {
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

function formatDoctorCanaryForPrompt(canary?: DoctorCanaryResult): string {
  if (!canary) {
    return "Doctor canary: not yet recorded. Add ORCH_CANARY handling to your doctor wrapper.";
  }

  if (canary.status === "skipped") {
    return `Doctor canary: skipped (${canary.reason}).`;
  }

  const lines = [
    canary.status === "unexpected_pass"
      ? "Doctor canary: DID NOT fail when ORCH_CANARY=1 (unexpected pass)."
      : "Doctor canary: failed as expected when ORCH_CANARY=1.",
    `Exit code: ${canary.exitCode}`,
  ];

  if (canary.output.trim().length > 0) {
    lines.push("Output:", canary.output);
  }

  return lines.join("\n");
}

function normalizeDoctorCanary(canary?: DoctorCanaryResult): DoctorCanaryResult | undefined {
  if (!canary) return undefined;
  if (canary.status === "skipped") return canary;

  return {
    ...canary,
    output: truncate(canary.output, DOCTOR_CANARY_LOG_LIMIT).text,
  };
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

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
