import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import type { LogSummaryConfig, ProjectConfig } from "../core/config.js";
import { LogIndex, logIndexPath, type LogIndexQuery } from "../core/log-index.js";
import { loadRunStateForProject } from "../core/state-store.js";
import type { RunState, TaskState } from "../core/state.js";
import {
  followJsonlFile,
  readJsonlFile,
  searchLogs,
  taskEventsLogPathForId,
  findTaskLogDir,
  type JsonlFilter,
  type LogSearchResult,
} from "../core/log-query.js";
import type { PathsContext } from "../core/paths.js";
import { resolveRunLogsDir } from "../core/paths.js";
import {
  loadRunEvents,
  listTaskEventLogs,
  readDoctorLogSnippet,
  type RunLogEvent,
} from "../core/run-logs.js";
import type { DoctorValidationReport } from "../validators/doctor-validator.js";
import type { TestValidationReport } from "../validators/test-validator.js";
import type { StyleValidationReport } from "../validators/style-validator.js";
import { AnthropicClient } from "../llm/anthropic.js";
import type { LlmClient } from "../llm/client.js";
import { MockLlmClient, isMockLlmEnabled } from "../llm/mock.js";
import { OpenAiClient } from "../llm/openai.js";
import { loadConfigForCli } from "./config.js";

type ValidatorSummaryRow = {
  validator: string;
  status: string;
  summary: string | null;
  reportPath: string | null;
};

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description("Inspect orchestrator and task logs")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--use-index", "Query logs via SQLite index (builds if missing)", false)
    .option("--follow", "Follow orchestrator + task logs", false);

  logs
    .command("query")
    .description("Print JSONL events for orchestrator or a task")
    .option("--task <id>", "Task ID to filter")
    .option("--type <glob>", "Filter by event type (supports *)")
    .option("--follow", "Follow log output", false)
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsQuery(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        typeGlob: opts.type,
        follow: opts.follow ?? false,
        useIndex: ctx.useIndex,
      }, ctx.paths);
    });

  logs
    .command("search")
    .description("Search across run logs for a substring (grep-style)")
    .argument("<pattern>", "String to search for")
    .option("--task <id>", "Limit search to a specific task")
    .action(async (pattern, opts, command) => {
      const ctx = await buildContext(command);
      await logsSearch(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        pattern,
        taskId: opts.task,
        useIndex: ctx.useIndex,
      }, ctx.paths);
    });

  logs
    .command("timeline")
    .description("Show batch/task timeline with retries and merges")
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsTimeline(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        useIndex: ctx.useIndex,
      }, ctx.paths);
    });

  logs
    .command("failures")
    .description("Summarize failures for a run")
    .option("--task <id>", "Limit to a specific task")
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsFailures(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        useIndex: ctx.useIndex,
      }, ctx.paths);
    });

  logs
    .command("doctor")
    .description("Show raw doctor output for a task attempt")
    .requiredOption("--task <id>", "Task ID")
    .option("--attempt <n>", "Attempt number", (v: string) => parseInt(v, 10))
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsDoctor(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        attempt: opts.attempt,
      }, ctx.paths);
    });

  logs
    .command("summarize")
    .description("Summarize validator results for a task")
    .requiredOption("--task <id>", "Task ID")
    .option("--llm", "Use LLM to summarize validator failures", false)
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsSummarize(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        useLlm: opts.llm ?? false,
        useIndex: ctx.useIndex,
      }, ctx.paths);
    });

  logs.action(async (opts, command) => {
    const ctx = await buildContext(command);
    if (opts.follow) {
      await logsFollow(ctx.projectName, ctx.config, { runId: ctx.runId }, ctx.paths);
      return;
    }
    await logsQuery(ctx.projectName, ctx.config, {
      runId: ctx.runId,
      useIndex: ctx.useIndex,
    }, ctx.paths);
  });
}

export async function logsQuery(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId?: string; typeGlob?: string; follow?: boolean; useIndex?: boolean },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const filter: JsonlFilter = {};
  if (opts.taskId) filter.taskId = opts.taskId;
  if (opts.typeGlob) filter.typeGlob = opts.typeGlob;

  const preferIndex = opts.useIndex ?? false;
  if (preferIndex && opts.follow) {
    console.log("--use-index is ignored when --follow is set; streaming from log file instead.");
  }

  if (preferIndex && !opts.follow) {
    const indexedLines = queryLogsFromIndex(runLogs, filter);
    if (indexedLines !== null) {
      for (const line of indexedLines) {
        console.log(line);
      }
      return;
    }
  }

  const target =
    opts.taskId === undefined
      ? path.join(runLogs.dir, "orchestrator.jsonl")
      : taskEventsLogPathForId(runLogs.dir, opts.taskId);

  if (!target) {
    console.log(`No logs found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(target)) {
    console.log(`Log file not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const lines = readJsonlFile(target, filter);
  for (const line of lines) {
    console.log(line);
  }

  if (opts.follow) {
    console.log(`\nFollowing ${target} (Ctrl+C to stop)...`);
    const stop = followJsonlFile(target, filter, (newLines) => {
      for (const line of newLines) {
        console.log(line);
      }
    });

    attachExitHandlers(stop);
    await waitIndefinitely();
  }
}

export async function logsFollow(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const orchestratorPath = path.join(runLogs.dir, "orchestrator.jsonl");
  const followers: Array<() => void> = [];
  const timers: NodeJS.Timeout[] = [];
  const seen = new Set<string>();

  const followTarget = (filePath: string, label: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);

    if (!fs.existsSync(filePath)) return;

    const relative = relativeToRun(runLogs.dir, filePath);
    const effectiveLabel = label || relative;
    console.log(`Attaching to ${effectiveLabel}`);

    const existing = readJsonlFile(filePath, {});
    for (const line of existing) {
      console.log(`${effectiveLabel}: ${line}`);
    }

    const stop = followJsonlFile(filePath, {}, (lines) => {
      for (const line of lines) {
        console.log(`${effectiveLabel}: ${line}`);
      }
    });

    followers.push(stop);
  };

  if (fs.existsSync(orchestratorPath)) {
    followTarget(orchestratorPath, "orchestrator");
  } else {
    console.log(`Orchestrator log not found at ${orchestratorPath}`);
  }

  const attachTaskLogs = (): void => {
    const taskLogs = listTaskEventLogs(runLogs.dir);
    for (const logPath of taskLogs) {
      const rel = relativeToRun(runLogs.dir, logPath);
      const label = path.dirname(rel);
      followTarget(logPath, label);
    }
  };

  attachTaskLogs();
  timers.push(setInterval(attachTaskLogs, 2000));

  const cleanup = (): void => {
    for (const stop of followers) stop();
    for (const timer of timers) clearInterval(timer);
  };

  attachExitHandlers(cleanup);
  console.log(`Following run ${runLogs.runId} logs (Ctrl+C to stop)...`);
  await waitIndefinitely();
}

export async function logsSearch(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; pattern: string; taskId?: string; useIndex?: boolean },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const preferIndex = opts.useIndex ?? false;
  let matches: LogSearchResult[];
  if (preferIndex) {
    const indexed = trySearchWithIndex(runLogs, opts.pattern, opts.taskId);
    matches = indexed ?? searchLogs(runLogs.dir, opts.pattern, { taskId: opts.taskId });
  } else {
    matches = searchLogs(runLogs.dir, opts.pattern, { taskId: opts.taskId });
  }
  if (matches.length === 0) {
    console.log(`No matches for "${opts.pattern}" in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  for (const match of matches) {
    const relPath = relativeToRun(runLogs.dir, match.filePath);
    console.log(`${relPath}:${match.lineNumber}:${match.line}`);
  }
}

type TimelineEntry = {
  ts: string;
  label: string;
  details?: string;
};

type TimelineResult = {
  entries: TimelineEntry[];
  runDurationMs?: number;
  taskCounts?: TaskCounts | null;
};

type TaskCounts = {
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

type FailureExample = {
  ts: string;
  taskId: string | null;
  attempt: number | null;
  message: string;
  source: string;
  snippet?: string | null;
};

type FailureGroup = {
  key: string;
  label: string;
  count: number;
  examples: FailureExample[];
};

type CodexTurnInfo = {
  attempt: number | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number | null;
};

type LogSummaryInput = {
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

export async function logsTimeline(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; useIndex?: boolean },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const events = loadRunEvents(runLogs.runId, runLogs.dir, { useIndex: opts.useIndex });
  if (events.length === 0) {
    console.log(`No events found for run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  const stateResolved = await loadRunStateForProject(projectName, runLogs.runId, paths);
  const timeline = buildTimeline(events, stateResolved?.state ?? null);

  console.log(`Timeline for run ${runLogs.runId}:`);
  for (const entry of timeline.entries) {
    const detail = entry.details ? ` — ${entry.details}` : "";
    console.log(`- ${formatTimestamp(entry.ts)} ${entry.label}${detail}`);
  }

  const stats: string[] = [];
  if (timeline.runDurationMs !== undefined) {
    stats.push(`Run duration: ${formatDuration(timeline.runDurationMs)}`);
  }
  if (timeline.taskCounts) {
    const counts = timeline.taskCounts;
    stats.push(
      `Tasks: ${counts.complete} complete, ${counts.validated} validated, ${counts.failed} failed, ${counts.running} running, ${counts.pending} pending`,
    );
  }
  if (stats.length > 0) {
    console.log("");
    for (const line of stats) {
      console.log(line);
    }
  }
}

export async function logsFailures(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId?: string; useIndex?: boolean },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const events = loadRunEvents(runLogs.runId, runLogs.dir, {
    useIndex: opts.useIndex,
    taskId: opts.taskId,
  });
  const groups = buildFailureGroups(events, runLogs.dir);

  if (groups.length === 0) {
    console.log(`No failures recorded for run ${runLogs.runId}${opts.taskId ? ` (task ${opts.taskId})` : ""}.`);
    return;
  }

  console.log(`Failure digest for run ${runLogs.runId}:`);
  for (const group of groups) {
    const header = `${group.label} (${group.count})`;
    console.log(`- ${header}`);
    for (const example of group.examples) {
      const prefixParts = [
        formatTimestamp(example.ts),
        example.taskId ? `task ${example.taskId}` : null,
        example.attempt ? `attempt ${example.attempt}` : null,
      ].filter(Boolean);
      const prefix = prefixParts.join(" ");
      const snippet = example.snippet ? ` — ${example.snippet}` : "";
      console.log(`  • ${prefix}: ${example.message}${snippet}`);
    }
  }
}

export async function logsDoctor(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId: string; attempt?: number },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const taskDir = findTaskLogDir(runLogs.dir, opts.taskId);
  if (!taskDir) {
    console.log(`No logs directory found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  const doctorFiles = fs
    .readdirSync(taskDir)
    .filter((file) => /^doctor-\d+\.log$/i.test(file))
    .sort();

  if (doctorFiles.length === 0) {
    console.log(`No doctor logs found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  if (opts.attempt !== undefined && (!Number.isInteger(opts.attempt) || opts.attempt <= 0)) {
    console.log("--attempt must be a positive integer.");
    process.exitCode = 1;
    return;
  }

  const selected = pickDoctorLog(doctorFiles, opts.attempt);
  if (!selected) {
    console.log(`Doctor log for attempt ${opts.attempt} not found for task ${opts.taskId}.`);
    process.exitCode = 1;
    return;
  }

  const attemptNum = selected.attempt;
  const fullPath = path.join(taskDir, selected.fileName);
  const content = fs.readFileSync(fullPath, "utf8");

  console.log(
    `Doctor log for task ${opts.taskId} (run ${runLogs.runId}, attempt ${attemptNum}): ${fullPath}`,
  );
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}

export async function logsSummarize(
  projectName: string,
  config: ProjectConfig,
  opts: { runId?: string; taskId: string; useLlm?: boolean; useIndex?: boolean },
  paths?: PathsContext,
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId, paths);
  if (!runLogs) return;

  const stateResolved = await loadRunStateForProject(projectName, runLogs.runId, paths);
  const taskState = stateResolved?.state.tasks[opts.taskId] ?? null;
  const events = loadRunEvents(runLogs.runId, runLogs.dir, {
    useIndex: opts.useIndex,
    taskId: opts.taskId,
  });

  const validatorSummaries = await collectValidatorSummaries(runLogs.dir, opts.taskId, taskState);
  const lastDoctorAttempt = findLastAttempt(events, (e) => e.type.startsWith("doctor."));
  const doctorLog = readDoctorLogSnippet(runLogs.dir, opts.taskId, lastDoctorAttempt);
  const lastCodexTurn = findLastCodexTurn(events);
  const statusLine = buildStatusLine(taskState);
  const nextAction = suggestNextAction(taskState, validatorSummaries, doctorLog, lastCodexTurn);

  console.log(`Summary for task ${opts.taskId} (run ${runLogs.runId}):`);
  console.log(`- ${statusLine}`);

  if (lastCodexTurn) {
    const codexParts = compact([
      lastCodexTurn.completedAt
        ? `completed ${formatTimestamp(lastCodexTurn.completedAt)}`
        : lastCodexTurn.startedAt
          ? `started ${formatTimestamp(lastCodexTurn.startedAt)}`
          : null,
      lastCodexTurn.attempt ? `attempt ${lastCodexTurn.attempt}` : null,
      lastCodexTurn.durationMs ? `turn duration ${formatDuration(lastCodexTurn.durationMs)}` : null,
    ]);
    console.log(`- Last Codex turn: ${codexParts ?? "not recorded"}`);
  } else {
    console.log("- Last Codex turn: not recorded");
  }

  if (doctorLog) {
    console.log(`- Last doctor log (${relativeToRun(runLogs.dir, doctorLog.path)}):`);
    console.log(indentMultiline(doctorLog.content));
  } else {
    console.log("- Last doctor log: not found");
  }

  console.log("- Validator results:");
  if (validatorSummaries.length === 0) {
    console.log("  • none found");
  } else {
    for (const entry of validatorSummaries) {
      const summaryText = entry.summary ?? "(no summary available)";
      console.log(`  • ${entry.validator}: ${entry.status} — ${summaryText}`);
      if (entry.reportPath) {
        console.log(`    Report: ${entry.reportPath}`);
      }
    }
  }

  if (taskState?.human_review) {
    const review = taskState.human_review;
    console.log("");
    console.log(
      `Human review required by ${review.validator}: ${review.reason}${review.summary ? ` — ${review.summary}` : ""}`,
    );
    if (review.report_path) {
      console.log(`Report: ${relativeToRun(runLogs.dir, review.report_path)}`);
    }
  }

  console.log(`- Next action: ${nextAction}`);

  if (opts.useLlm) {
    await runLlmSummary(config, {
      runId: runLogs.runId,
      taskId: opts.taskId,
      statusLine,
      nextAction,
      attempts: taskState?.attempts ?? null,
      lastError: taskState?.last_error ?? null,
      doctorText: doctorLog?.content ?? null,
      codex: lastCodexTurn,
      validators: validatorSummaries,
    });
  }
}

// =============================================================================
// TIMELINE + FAILURE HELPERS
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

  if (!summaries.some((s) => s.validator === "test")) {
    const report = await findTestValidatorReport(runLogsDir, taskId);
    if (report) summaries.push(report);
  }

  if (!summaries.some((s) => s.validator === "style")) {
    const report = await findStyleValidatorReport(runLogsDir, taskId);
    if (report) summaries.push(report);
  }

  if (!summaries.some((s) => s.validator === "doctor")) {
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
      const attempt = event.attempt ?? numberFrom((event.payload as { attempt?: unknown })?.attempt);
      startByAttempt.set(attempt ?? null, event.ts);
    }

    if (event.type === "turn.complete") {
      const attempt = event.attempt ?? numberFrom((event.payload as { attempt?: unknown })?.attempt);
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

  const failingValidator = validators.find((v) => ["fail", "error"].includes(v.status));
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

function indentMultiline(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function runLlmSummary(config: ProjectConfig, input: LogSummaryInput): Promise<void> {
  const cfg = config.log_summaries;
  if (!cfg || cfg.enabled === false) {
    console.log("");
    console.log("LLM summaries disabled in config (log_summaries.enabled=false).");
    return;
  }

  if (!cfg.model) {
    console.log("");
    console.log("log_summaries.model is required when using --llm; showing rule-based summary.");
    process.exitCode = 1;
    return;
  }

  let client: LlmClient;
  try {
    client = createLogSummaryClient(cfg);
  } catch (err) {
    console.log("");
    console.log(`LLM client unavailable: ${formatError(err)}`);
    process.exitCode = 1;
    return;
  }

  const prompt = buildLogSummaryPrompt(input);
  try {
    const result = await client.complete(prompt, {
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });
    console.log("");
    console.log("LLM summary:");
    console.log(result.text.trim());
  } catch (err) {
    console.log("");
    console.log(`LLM summarization failed: ${formatError(err)}`);
    process.exitCode = 1;
  }
}

function buildLogSummaryPrompt(input: LogSummaryInput): string {
  const validatorLines =
    input.validators.length === 0
      ? "- none"
      : input.validators
          .map(
            (v) => `- ${v.validator}: ${v.status}${v.summary ? ` — ${v.summary}` : ""}`,
          )
          .join("\n");

  const codexLine = input.codex
    ? compact([
        input.codex.completedAt
          ? `completed ${formatTimestamp(input.codex.completedAt)}`
          : input.codex.startedAt
            ? `started ${formatTimestamp(input.codex.startedAt)}`
            : null,
        input.codex.attempt ? `attempt ${input.codex.attempt}` : null,
        input.codex.durationMs ? `turn duration ${formatDuration(input.codex.durationMs)}` : null,
      ]) ?? "unknown"
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
      ? parseDurationMs(state.started_at, state.updated_at) ?? undefined
      : parseDurationMs(events[0]?.ts, events[events.length - 1]?.ts) ?? undefined;

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
        details: compact([
          baseDetails,
          exitCode !== null ? `exit ${exitCode}` : null,
          summary,
        ]),
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

function formatTimestamp(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatDuration(ms?: number | null): string {
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
  const filtered = parts.filter((p) => p && p.trim().length > 0) as string[];
  return filtered.length > 0 ? filtered.join(" | ") : undefined;
}

function attemptDetail(attempt?: number | null): string | undefined {
  if (attempt === undefined || attempt === null) return undefined;
  return `attempt ${attempt}`;
}

function formatTaskList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((v) => stringFrom(v))
    .filter(Boolean)
    .map((v) => String(v));
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

function summarizeTestReport(report: TestValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.coverage_gaps.length > 0) {
    parts.push(`Coverage gaps: ${report.coverage_gaps.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

function summarizeStyleReport(report: StyleValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

function summarizeDoctorReport(report: DoctorValidationReport): string {
  const parts = [
    `Effective: ${report.effective ? "yes" : "no"}`,
    `Coverage: ${report.coverage_assessment}`,
  ];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.recommendations.length > 0) {
    parts.push(`Recs: ${report.recommendations.length}`);
  }
  return parts.join(" | ");
}

function queryLogsFromIndex(
  runLogs: { runId: string; dir: string },
  filter: JsonlFilter,
): string[] | null {
  const dbPath = logIndexPath(runLogs.dir);
  const indexFilter: LogIndexQuery = {};
  if (filter.taskId) indexFilter.taskId = filter.taskId;
  if (filter.typeGlob) indexFilter.typeGlob = filter.typeGlob;

  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents(indexFilter);
    return events.map((event) => event.raw);
  } catch (err) {
    console.log(
      `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to JSONL files.`,
    );
    return null;
  } finally {
    if (index) index.close();
  }
}

function trySearchWithIndex(
  runLogs: { runId: string; dir: string },
  pattern: string,
  taskId?: string,
): LogSearchResult[] | null {
  const dbPath = logIndexPath(runLogs.dir);
  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents({ taskId, search: pattern });
    return events.map((event) => ({
      filePath: path.join(runLogs.dir, event.source),
      lineNumber: event.lineNumber,
      line: event.raw,
    }));
  } catch (err) {
    console.log(
      `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to file search.`,
    );
    return null;
  } finally {
    if (index) index.close();
  }
}

async function buildContext(command: Command): Promise<{
  projectName: string;
  runId?: string;
  config: ProjectConfig;
  useIndex: boolean;
  paths: PathsContext;
}> {
  const opts = command.optsWithGlobals() as {
    project?: string;
    runId?: string;
    config?: string;
    useIndex?: boolean;
  };
  if (!opts.project) {
    throw new Error("Project name is required");
  }

  const { appContext, config, projectName } = await loadConfigForCli({
    projectName: opts.project,
    explicitConfigPath: opts.config,
    initIfMissing: false,
  });

  return {
    projectName,
    runId: opts.runId,
    config,
    useIndex: opts.useIndex ?? false,
    paths: appContext.paths,
  };
}

function resolveRunLogsOrWarn(
  projectName: string,
  runId?: string,
  paths?: PathsContext,
): { runId: string; dir: string } | null {
  const resolved = resolveRunLogsDir(projectName, runId, paths);
  if (resolved) {
    return resolved;
  }

  const message = runId
    ? `Run ${runId} not found for project ${projectName}.`
    : `No runs found for project ${projectName}.`;
  console.log(message);
  process.exitCode = 1;
  return null;
}

function pickDoctorLog(
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

function relativeToRun(baseDir: string, targetPath: string): string {
  const relative = path.relative(baseDir, targetPath);
  return relative.startsWith("..") ? targetPath : relative;
}

function attachExitHandlers(cleanup: () => void): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.once(signal, () => {
      cleanup();
      process.exit();
    });
  }
}

function waitIndefinitely(): Promise<void> {
  return new Promise(() => undefined);
}
