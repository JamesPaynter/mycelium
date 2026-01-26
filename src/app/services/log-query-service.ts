/*
Purpose: App-layer helpers for querying run logs, building timelines, and summarizing validator output.
Key assumptions: Run log directories follow core/paths and core/log-query conventions; CLI handles output and exit codes.
Usage: Instantiate LogQueryService with config for index queries and LLM summaries; use buildTimeline/buildFailureGroups for reporting.
*/
import fs from "node:fs";
import path from "node:path";

import type { LogSummaryConfig, ProjectConfig } from "../../core/config.js";
import { LogIndex, logIndexPath, type LogIndexQuery } from "../../core/log-index.js";
import type { JsonlFilter, LogSearchResult } from "../../core/log-query.js";
import { readDoctorLogSnippet } from "../../core/run-logs.js";
import type { RunLogEvent } from "../../core/run-logs.js";
import type { RunState, TaskState } from "../../core/state.js";
import { AnthropicClient } from "../../llm/anthropic.js";
import type { LlmClient } from "../../llm/client.js";
import { MockLlmClient, isMockLlmEnabled } from "../../llm/mock.js";
import { OpenAiClient } from "../../llm/openai.js";
import type { DoctorValidationReport } from "../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../validators/style-validator.js";
import type { TestValidationReport } from "../../validators/test-validator.js";
import {
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "../orchestrator/validation/summaries.js";

// =============================================================================
// TYPES
// =============================================================================

export type ValidatorSummaryRow = {
  validator: string;
  status: string;
  summary: string | null;
  reportPath: string | null;
};

export type TimelineEntry = {
  ts: string;
  label: string;
  details?: string;
};

export type TimelineResult = {
  entries: TimelineEntry[];
  runDurationMs?: number;
  taskCounts?: TaskCounts | null;
};

export type TaskCounts = {
  total: number;
  pending: number;
  running: number;
  validated: number;
  complete: number;
  failed: number;
  needs_human_review: number;
  needs_rescope: number;
  rescope_required: number;
  skipped: number;
};

export type FailureExample = {
  ts: string;
  taskId: string | null;
  attempt: number | null;
  message: string;
  source: string;
  snippet?: string | null;
};

export type FailureGroup = {
  key: string;
  label: string;
  count: number;
  examples: FailureExample[];
};

export type CodexTurnInfo = {
  attempt: number | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number | null;
};

export type LogSummaryInput = {
  runId: string;
  taskId: string;
  statusLine: string;
  attempts: number | null;
  lastError: string | null;
  doctorText: string | null;
  codex: CodexTurnInfo | null;
  validators: ValidatorSummaryRow[];
  nextAction: string;
};

export type LogIndexQueryResult =
  | { status: "ok"; lines: string[] }
  | { status: "error"; message: string };

export type LogIndexSearchResult =
  | { status: "ok"; matches: LogSearchResult[] }
  | { status: "error"; message: string };

export type LlmSummaryResult =
  | { status: "ok"; text: string }
  | { status: "disabled"; message: string }
  | { status: "error"; message: string };

// =============================================================================
// SERVICE
// =============================================================================

export class LogQueryService {
  private readonly config: ProjectConfig;

  constructor(config: ProjectConfig) {
    this.config = config;
  }

  queryLogsFromIndex(
    runLogs: { runId: string; dir: string },
    filter: JsonlFilter,
  ): LogIndexQueryResult {
    return queryLogsFromIndex(runLogs, filter);
  }

  searchLogsFromIndex(
    runLogs: { runId: string; dir: string },
    pattern: string,
    taskId?: string,
  ): LogIndexSearchResult {
    return searchLogsFromIndex(runLogs, pattern, taskId);
  }

  buildTimeline(events: RunLogEvent[], state: RunState | null): TimelineResult {
    return buildTimeline(events, state);
  }

  buildFailureGroups(events: RunLogEvent[], runLogsDir: string): FailureGroup[] {
    return buildFailureGroups(events, runLogsDir);
  }

  collectValidatorSummaries(
    runLogsDir: string,
    taskId: string,
    taskState?: TaskState | null,
  ): Promise<ValidatorSummaryRow[]> {
    return collectValidatorSummaries(runLogsDir, taskId, taskState);
  }

  buildStatusLine(taskState?: TaskState | null): string {
    return buildStatusLine(taskState);
  }

  findLastAttempt(
    events: RunLogEvent[],
    predicate: (event: RunLogEvent) => boolean,
  ): number | null {
    return findLastAttempt(events, predicate);
  }

  findLastCodexTurn(events: RunLogEvent[]): CodexTurnInfo | null {
    return findLastCodexTurn(events);
  }

  suggestNextAction(
    taskState: TaskState | null,
    validators: ValidatorSummaryRow[],
    doctorLog: { content: string } | null,
    codexTurn: CodexTurnInfo | null,
  ): string {
    return suggestNextAction(taskState, validators, doctorLog, codexTurn);
  }

  runLlmSummary(input: LogSummaryInput): Promise<LlmSummaryResult> {
    return runLlmSummary(this.config, input);
  }

  formatTimestamp(ts: string): string {
    return formatTimestamp(ts);
  }

  formatDuration(ms?: number | null): string {
    return formatDuration(ms);
  }

  relativeToRun(baseDir: string, targetPath: string): string {
    return relativeToRun(baseDir, targetPath);
  }

  pickDoctorLog(files: string[], attempt?: number): { attempt: number; fileName: string } | null {
    return pickDoctorLog(files, attempt);
  }
}

// =============================================================================
// INDEX QUERIES
// =============================================================================

function queryLogsFromIndex(
  runLogs: { runId: string; dir: string },
  filter: JsonlFilter,
): LogIndexQueryResult {
  const dbPath = logIndexPath(runLogs.dir);
  const indexFilter: LogIndexQuery = {};
  if (filter.taskId) indexFilter.taskId = filter.taskId;
  if (filter.typeGlob) indexFilter.typeGlob = filter.typeGlob;

  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents(indexFilter);
    return { status: "ok", lines: events.map((event) => event.raw) };
  } catch (err) {
    return {
      status: "error",
      message: `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to JSONL files.`,
    };
  } finally {
    if (index) index.close();
  }
}

function searchLogsFromIndex(
  runLogs: { runId: string; dir: string },
  pattern: string,
  taskId?: string,
): LogIndexSearchResult {
  const dbPath = logIndexPath(runLogs.dir);
  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents({ taskId, search: pattern });
    return {
      status: "ok",
      matches: events.map((event) => ({
        filePath: path.join(runLogs.dir, event.source),
        lineNumber: event.lineNumber,
        line: event.raw,
      })),
    };
  } catch (err) {
    return {
      status: "error",
      message: `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to file search.`,
    };
  } finally {
    if (index) index.close();
  }
}

// =============================================================================
// TIMELINE + FAILURE HELPERS
// =============================================================================

export function buildTimeline(events: RunLogEvent[], state: RunState | null): TimelineResult {
  const entries: TimelineEntry[] = [];
  const taskDurations = state ? buildTaskDurations(state) : new Map<string, number>();
  const batchDurations = state ? buildBatchDurations(state) : new Map<number, number>();

  for (const event of events) {
    const described = describeTimelineEvent(event, taskDurations, batchDurations);
    if (described) {
      entries.push({ ts: event.ts, ...described });
    }
  }

  const runDurationMs =
    state?.started_at && state?.updated_at
      ? (parseDurationMs(state.started_at, state.updated_at) ?? undefined)
      : (parseDurationMs(events[0]?.ts, events[events.length - 1]?.ts) ?? undefined);

  const taskCounts = state ? buildTaskCounts(state) : null;
  return { entries, runDurationMs, taskCounts };
}

function describeTimelineEvent(
  event: RunLogEvent,
  taskDurations: Map<string, number>,
  batchDurations: Map<number, number>,
): { label: string; details?: string } | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const attempt = event.attempt ?? numberFrom(payload.attempt);
  const taskId = event.taskId ?? stringFrom(payload.task_id);
  const baseDetails = attemptDetail(attempt);

  switch (event.type) {
    case "run.start":
      return { label: "Run started" };
    case "run.resume":
      return { label: "Run resumed", details: stringFrom(payload.reason) ?? undefined };
    case "run.stop":
      return { label: "Run stop requested", details: stringFrom(payload.reason) ?? undefined };
    case "run.complete":
      return {
        label: `Run completed (${stringFrom(payload.status) ?? "unknown"})`,
      };
    case "batch.start": {
      const batchId = numberFrom(payload.batch_id);
      return {
        label: `Batch ${batchId ?? "?"} started`,
        details: formatTaskList(payload.tasks),
      };
    }
    case "batch.merging": {
      const batchId = numberFrom(payload.batch_id);
      return {
        label: `Batch ${batchId ?? "?"} merging`,
        details: formatTaskList(payload.tasks),
      };
    }
    case "batch.merge_conflict": {
      const batchId = numberFrom(payload.batch_id);
      const reason = stringFrom(payload.reason) ?? stringFrom(payload.conflict);
      return { label: `Batch ${batchId ?? "?"} merge conflict`, details: reason ?? undefined };
    }
    case "batch.complete": {
      const batchId = numberFrom(payload.batch_id);
      const duration = batchId !== null ? batchDurations.get(batchId) : undefined;
      return {
        label: `Batch ${batchId ?? "?"} complete`,
        details: compact([durationLabel(duration)]),
      };
    }
    case "worker.start":
      return { label: `Task ${taskId ?? "?"} worker started` };
    case "turn.start":
      return {
        label: `Task ${taskId ?? "?"} Codex turn start`,
        details: baseDetails,
      };
    case "turn.complete":
      return {
        label: `Task ${taskId ?? "?"} Codex turn complete`,
        details: baseDetails,
      };
    case "task.retry":
      return {
        label: `Task ${taskId ?? "?"} retry`,
        details: baseDetails,
      };
    case "doctor.start":
      return {
        label: `Task ${taskId ?? "?"} doctor start`,
        details: baseDetails,
      };
    case "doctor.pass":
      return {
        label: `Task ${taskId ?? "?"} doctor passed`,
        details: baseDetails,
      };
    case "doctor.fail": {
      const exitCode = numberFrom(payload.exit_code);
      const summary = stringFrom(payload.summary);
      return {
        label: `Task ${taskId ?? "?"} doctor failed`,
        details: compact([baseDetails, exitCode !== null ? `exit ${exitCode}` : null, summary]),
      };
    }
    case "task.complete": {
      const duration = taskId ? taskDurations.get(taskId) : undefined;
      const attempts = numberFrom(payload.attempts);
      return {
        label: `Task ${taskId ?? "?"} complete`,
        details: compact([attempts ? `${attempts} attempt(s)` : null, durationLabel(duration)]),
      };
    }
    case "task.failed": {
      const duration = taskId ? taskDurations.get(taskId) : undefined;
      const attempts = numberFrom(payload.attempts);
      const message = stringFrom(payload.message);
      return {
        label: `Task ${taskId ?? "?"} failed`,
        details: compact([
          attempts ? `${attempts} attempt(s)` : null,
          durationLabel(duration),
          message,
        ]),
      };
    }
    case "task.rescope.start":
    case "task.rescope.updated":
    case "task.rescope.failed": {
      const reason = stringFrom(payload.reason);
      return {
        label: `Task ${taskId ?? "?"} ${event.type.replace("task.", "").replace(".", " ")}`,
        details: compact([baseDetails, reason]),
      };
    }
    case "validator.fail":
    case "validator.error":
    case "validator.block": {
      const validator = stringFrom(payload.validator) ?? "validator";
      const suffix = event.type.split(".")[1] ?? event.type;
      return {
        label: `Validator ${validator} ${suffix}`,
        details: taskId ? `task ${taskId}` : undefined,
      };
    }
    default:
      return null;
  }
}

function buildTaskCounts(state: RunState): TaskCounts {
  const counts: TaskCounts = {
    total: Object.keys(state.tasks).length,
    pending: 0,
    running: 0,
    validated: 0,
    complete: 0,
    failed: 0,
    needs_human_review: 0,
    needs_rescope: 0,
    rescope_required: 0,
    skipped: 0,
  };

  for (const task of Object.values(state.tasks)) {
    counts[task.status] += 1;
  }

  return counts;
}

function buildTaskDurations(state: RunState): Map<string, number> {
  const durations = new Map<string, number>();
  for (const [taskId, task] of Object.entries(state.tasks)) {
    const duration = parseDurationMs(task.started_at, task.completed_at);
    if (duration !== null) {
      durations.set(taskId, duration);
    }
  }
  return durations;
}

function buildBatchDurations(state: RunState): Map<number, number> {
  const durations = new Map<number, number>();
  for (const batch of state.batches) {
    const duration = parseDurationMs(batch.started_at, batch.completed_at);
    if (duration !== null) {
      durations.set(batch.batch_id, duration);
    }
  }
  return durations;
}

function parseDurationMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return endMs - startMs;
}

export function buildFailureGroups(events: RunLogEvent[], runLogsDir: string): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const event of events) {
    const failure = classifyFailure(event, runLogsDir);
    if (!failure) continue;

    const current = groups.get(failure.key);
    if (!current) {
      groups.set(failure.key, {
        key: failure.key,
        label: failure.label,
        count: 1,
        examples: [failure.example],
      });
    } else {
      current.count += 1;
      if (current.examples.length < 3) {
        current.examples.push(failure.example);
      }
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

function classifyFailure(
  event: RunLogEvent,
  runLogsDir: string,
): { key: string; label: string; example: FailureExample } | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const taskId = event.taskId ?? stringFrom(payload.task_id);
  const baseExample: FailureExample = {
    ts: event.ts,
    taskId: taskId ?? null,
    attempt: event.attempt ?? numberFrom(payload.attempt),
    message: "",
    source: event.source,
  };

  const pickSnippet = (attempt?: number | null): string | null => {
    if (!taskId) return null;
    const snippet = readDoctorLogSnippet(runLogsDir, taskId, attempt ?? null);
    return snippet ? snippet.content.replace(/\s+/g, " ").trim() : null;
  };

  switch (event.type) {
    case "task.failed": {
      const message =
        stringFrom(payload.message) ?? "Task worker exited with a non-zero status or error.";
      return {
        key: "task.failed",
        label: "Task failures",
        example: { ...baseExample, message },
      };
    }
    case "task.rescope.failed": {
      const message = stringFrom(payload.reason) ?? "Rescope failed";
      return {
        key: "task.rescope.failed",
        label: "Rescope failures",
        example: { ...baseExample, message },
      };
    }
    case "doctor.fail": {
      const exitCode = numberFrom(payload.exit_code);
      const summary = stringFrom(payload.summary);
      const message = compact([
        summary ?? "Doctor command failed",
        exitCode !== null ? `exit ${exitCode}` : null,
      ]);
      return {
        key: "doctor.fail",
        label: "Doctor failures",
        example: {
          ...baseExample,
          message: message ?? "Doctor command failed",
          snippet: pickSnippet(baseExample.attempt),
        },
      };
    }
    case "doctor.canary.unexpected_pass": {
      const severity = stringFrom(payload.severity) ?? "warn";
      if (severity === "warn" || severity === "warning") {
        return null;
      }
      const message =
        stringFrom(payload.message) ??
        stringFrom(payload.reason) ??
        "Doctor canary unexpected pass";
      return {
        key: "doctor.canary.unexpected_pass",
        label: "Doctor canary unexpected passes",
        example: { ...baseExample, message },
      };
    }
    case "validator.fail":
    case "validator.error":
    case "validator.block": {
      const validator = stringFrom(payload.validator) ?? "validator";
      const suffix = event.type.split(".")[1] ?? event.type;
      const key = `validator.${suffix}.${validator}`;
      const message =
        stringFrom(payload.message) ??
        stringFrom(payload.reason) ??
        `${validator} ${suffix}`.trim();
      return {
        key,
        label: `Validator ${validator} ${suffix}`,
        example: { ...baseExample, message },
      };
    }
    case "batch.merge_conflict": {
      const message = stringFrom(payload.reason) ?? "Merge conflict detected";
      return {
        key: "batch.merge_conflict",
        label: "Merge conflicts",
        example: { ...baseExample, message },
      };
    }
    case "run.stop": {
      const reason = stringFrom(payload.reason) ?? "Run stopped";
      return {
        key: `run.stop.${reason}`,
        label: "Run stops",
        example: { ...baseExample, message: reason },
      };
    }
    case "worker.local.error": {
      const message = stringFrom(payload.message) ?? "Worker error";
      return {
        key: "worker.local.error",
        label: "Worker errors",
        example: { ...baseExample, message },
      };
    }
    case "container.exit": {
      const exitCode = numberFrom(payload.exit_code);
      if (exitCode === null || exitCode === 0) return null;
      return {
        key: "container.exit",
        label: "Container exits",
        example: {
          ...baseExample,
          message: `Container exit code ${exitCode}`,
        },
      };
    }
    case "budget.block": {
      const scope = stringFrom(payload.scope);
      const message = scope ? `Budget block (${scope})` : "Budget block";
      return {
        key: "budget.block",
        label: "Budget blocks",
        example: { ...baseExample, message },
      };
    }
    case "manifest.compliance.block": {
      const reason = stringFrom(payload.reason) ?? "Manifest enforcement blocked";
      return {
        key: "manifest.compliance.block",
        label: "Manifest blocks",
        example: { ...baseExample, message: reason },
      };
    }
    default:
      return null;
  }
}

// =============================================================================
// SUMMARY HELPERS
// =============================================================================

async function collectValidatorSummaries(
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

function buildStatusLine(taskState?: TaskState | null): string {
  if (!taskState) return "status unknown";

  const parts = [`status: ${taskState.status}`];
  if (taskState.attempts) parts.push(`attempts ${taskState.attempts}`);
  if (taskState.last_error) parts.push(taskState.last_error);
  return parts.join(" | ");
}

function findLastAttempt(
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

function findLastCodexTurn(events: RunLogEvent[]): CodexTurnInfo | null {
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

function suggestNextAction(
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

async function runLlmSummary(
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

// =============================================================================
// FORMAT + PATH HELPERS
// =============================================================================

export function formatTimestamp(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "n/a";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function durationLabel(ms?: number | null): string | undefined {
  if (ms === undefined || ms === null) return undefined;
  return `duration ${formatDuration(ms)}`;
}

function compact(parts: Array<string | null | undefined>): string | undefined {
  const filtered = parts.filter((part) => part && part.trim().length > 0) as string[];
  return filtered.length > 0 ? filtered.join(" | ") : undefined;
}

function attemptDetail(attempt?: number | null): string | undefined {
  if (attempt === undefined || attempt === null) return undefined;
  return `attempt ${attempt}`;
}

function formatTaskList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((item) => stringFrom(item))
    .filter(Boolean)
    .map((item) => String(item));
  if (names.length === 0) return undefined;
  return `tasks: ${names.join(", ")}`;
}

function stringFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function relativeToRun(baseDir: string, targetPath: string): string {
  const relative = path.relative(baseDir, targetPath);
  return relative.startsWith("..") ? targetPath : relative;
}

export function pickDoctorLog(
  files: string[],
  attempt?: number,
): { attempt: number; fileName: string } | null {
  const parsed = files
    .map((file) => {
      const match = file.match(/^doctor-(\d+)\.log$/i);
      return match ? { fileName: file, attempt: Number.parseInt(match[1], 10) } : null;
    })
    .filter(Boolean) as { attempt: number; fileName: string }[];

  if (parsed.length === 0) return null;

  if (attempt !== undefined) {
    return parsed.find((item) => item.attempt === attempt) ?? null;
  }

  return parsed.sort((a, b) => b.attempt - a.attempt)[0];
}

// =============================================================================
// VALIDATOR REPORT LOOKUP
// =============================================================================

async function findTestValidatorReport(
  runLogsDir: string,
  taskId: string,
): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "test-validator");
  const reportPath = await pickLatestJson(dir, (name) => name.startsWith(`${taskId}-`));
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<TestValidationReport>(reportPath);
  if (!report) return null;

  const status = report.pass ? "pass" : "fail";
  return {
    validator: "test",
    status,
    summary: summarizeTestReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

async function findStyleValidatorReport(
  runLogsDir: string,
  taskId: string,
): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "style-validator");
  const reportPath = await pickLatestJson(dir, (name) => name.startsWith(`${taskId}-`));
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<StyleValidationReport>(reportPath);
  if (!report) return null;

  const status = report.pass ? "pass" : "fail";
  return {
    validator: "style",
    status,
    summary: summarizeStyleReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

async function findDoctorValidatorReport(runLogsDir: string): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "doctor-validator");
  const reportPath = await pickLatestJson(dir);
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<DoctorValidationReport>(reportPath);
  if (!report) return null;

  const status = report.effective ? "pass" : "fail";
  return {
    validator: "doctor",
    status,
    summary: summarizeDoctorReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

async function pickLatestJson(
  dir: string,
  matcher: (name: string) => boolean = () => true,
): Promise<string | null> {
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(".json") && matcher(file));
  if (files.length === 0) return null;

  const withTime = files
    .map((file) => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return withTime[0]?.fullPath ?? null;
}

function readValidatorResultFromFile<T>(filePath: string): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const payload = (raw as { result?: unknown }).result;
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return payload as T;
  } catch {
    return null;
  }
}
