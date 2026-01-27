import type { LogSummaryConfig, ProjectConfig } from "../../../core/config.js";
import type { RunLogEvent } from "../../../core/run-logs.js";
import type { TaskState } from "../../../core/state.js";
import { AnthropicClient } from "../../../llm/anthropic.js";
import type { LlmClient } from "../../../llm/client.js";
import { MockLlmClient, isMockLlmEnabled } from "../../../llm/mock.js";
import { OpenAiClient } from "../../../llm/openai.js";

import type { CodexTurnInfo, LlmSummaryResult, LogSummaryInput, ValidatorSummaryRow } from "./types.js";
import { parseDurationMs, formatDuration, formatTimestamp } from "./time.js";
import { compact, numberFrom, relativeToRun } from "./utils.js";
import {
  findDoctorValidatorReport,
  findStyleValidatorReport,
  findTestValidatorReport,
} from "./validator-reports.js";

// =============================================================================
// SUMMARY HELPERS
// =============================================================================

export async function collectValidatorSummaries(
  runLogsDir: string,
  taskId: string,
  taskState?: TaskState | null,
): Promise<ValidatorSummaryRow[]> {
  const summaries: ValidatorSummaryRow[] = [];

  if (taskState) {
    for (const result of taskState.validator_results ?? []) {
      summaries.push({
        validator: result.validator,
        status: result.status,
        summary: result.summary ?? null,
        reportPath: result.report_path ? relativeToRun(runLogsDir, result.report_path) : null,
      });
    }
  }

  if (!summaries.some((summary) => summary.validator === "test")) {
    const report = await findTestValidatorReport(runLogsDir, taskId);
    if (report) summaries.push(report);
  }

  if (!summaries.some((summary) => summary.validator === "style")) {
    const report = await findStyleValidatorReport(runLogsDir, taskId);
    if (report) summaries.push(report);
  }

  if (!summaries.some((summary) => summary.validator === "doctor")) {
    const doctorReport = await findDoctorValidatorReport(runLogsDir);
    if (doctorReport) summaries.push(doctorReport);
  }

  return summaries;
}

export function buildStatusLine(taskState?: TaskState | null): string {
  if (!taskState) return "status unknown";

  const parts = [`status: ${taskState.status}`];
  if (taskState.attempts) parts.push(`attempts ${taskState.attempts}`);
  if (taskState.last_error) parts.push(taskState.last_error);
  return parts.join(" | ");
}

export function findLastAttempt(
  events: RunLogEvent[],
  predicate: (event: RunLogEvent) => boolean,
): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!predicate(event)) continue;
    return event.attempt ?? numberFrom((event.payload as { attempt?: unknown })?.attempt);
  }
  return null;
}

export function findLastCodexTurn(events: RunLogEvent[]): CodexTurnInfo | null {
  let last: CodexTurnInfo | null = null;
  const startByAttempt = new Map<number | null, string>();

  for (const event of events) {
    if (event.type === "turn.start") {
      const attempt =
        event.attempt ?? numberFrom((event.payload as { attempt?: unknown })?.attempt);
      startByAttempt.set(attempt ?? null, event.ts);
    }

    if (event.type === "turn.complete") {
      const attempt =
        event.attempt ?? numberFrom((event.payload as { attempt?: unknown })?.attempt);
      const startedAt = startByAttempt.get(attempt ?? null);
      last = {
        attempt: attempt ?? null,
        startedAt: startedAt ?? undefined,
        completedAt: event.ts,
        durationMs: parseDurationMs(startedAt, event.ts),
      };
    }
  }

  return last;
}

export function suggestNextAction(
  taskState: TaskState | null,
  validators: ValidatorSummaryRow[],
  doctorLog: { content: string } | null,
  codexTurn: CodexTurnInfo | null,
): string {
  if (taskState?.status === "complete") {
    return "Task is complete; verify merged changes and proceed to the next task.";
  }

  if (taskState?.status === "validated") {
    return "Task is validated; awaiting merge and integration doctor.";
  }

  if (taskState?.human_review) {
    return "Address the human review request before resuming the run.";
  }

  const failingValidator = validators.find((validator) =>
    ["fail", "error"].includes(validator.status),
  );
  if (failingValidator) {
    return `Fix "${failingValidator.validator}" findings and rerun doctor.`;
  }

  if (doctorLog) {
    return "Resolve the doctor failure shown above and rerun doctor for this task.";
  }

  if (taskState?.status === "failed") {
    return "Inspect worker logs for the last attempt and rerun the task.";
  }

  if (codexTurn?.attempt) {
    return `Resume with attempt ${codexTurn.attempt + 1} after reviewing the latest turn output.`;
  }

  return "Resume the run once outstanding issues are resolved.";
}

export async function runLlmSummary(
  config: ProjectConfig,
  input: LogSummaryInput,
): Promise<LlmSummaryResult> {
  const cfg = config.log_summaries;
  if (!cfg || cfg.enabled === false) {
    return {
      status: "disabled",
      message: "LLM summaries disabled in config (log_summaries.enabled=false).",
    };
  }

  if (!cfg.model) {
    return {
      status: "error",
      message: "log_summaries.model is required when using --llm; showing rule-based summary.",
    };
  }

  let client: LlmClient;
  try {
    client = createLogSummaryClient(cfg);
  } catch (err) {
    return {
      status: "error",
      message: `LLM client unavailable: ${formatError(err)}`,
    };
  }

  const prompt = buildLogSummaryPrompt(input);
  try {
    const result = await client.complete(prompt, {
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });
    return { status: "ok", text: result.text.trim() };
  } catch (err) {
    return {
      status: "error",
      message: `LLM summarization failed: ${formatError(err)}`,
    };
  }
}

function buildLogSummaryPrompt(input: LogSummaryInput): string {
  const validatorLines =
    input.validators.length === 0
      ? "- none"
      : input.validators
          .map(
            (validator) =>
              `- ${validator.validator}: ${validator.status}${validator.summary ? ` — ${validator.summary}` : ""}`,
          )
          .join("\n");

  const codexLine = input.codex
    ? (compact([
        input.codex.completedAt
          ? `completed ${formatTimestamp(input.codex.completedAt)}`
          : input.codex.startedAt
            ? `started ${formatTimestamp(input.codex.startedAt)}`
            : null,
        input.codex.attempt ? `attempt ${input.codex.attempt}` : null,
        input.codex.durationMs ? `turn duration ${formatDuration(input.codex.durationMs)}` : null,
      ]) ?? "unknown")
    : "unknown";

  return [
    `Summarize task ${input.taskId} for run ${input.runId}.`,
    `Status: ${input.statusLine}`,
    input.attempts ? `Attempts: ${input.attempts}` : null,
    input.lastError ? `Last error: ${input.lastError}` : null,
    `Last Codex turn: ${codexLine}`,
    "Doctor output:",
    input.doctorText ?? "<not found>",
    "Validator results:",
    validatorLines,
    `Suggested next action: ${input.nextAction}`,
    "Provide a concise failure digest, key evidence, and the single next action for the operator.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createLogSummaryClient(cfg: LogSummaryConfig): LlmClient {
  const model = cfg.model;
  if (!model) {
    throw new Error("log_summaries.model is required when using --llm.");
  }

  if (isMockLlmEnabled() || cfg.provider === "mock") {
    return new MockLlmClient();
  }

  if (cfg.provider === "openai") {
    return new OpenAiClient({
      model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
    });
  }

  if (cfg.provider === "anthropic") {
    return new AnthropicClient({
      model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
      apiKey: cfg.anthropic_api_key,
      baseURL: cfg.anthropic_base_url,
    });
  }

  throw new Error(`Unsupported log_summaries provider: ${cfg.provider}`);
}

function secondsToMs(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return value * 1000;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
