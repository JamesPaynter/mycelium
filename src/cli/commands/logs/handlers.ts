import fs from "node:fs";
import path from "node:path";

import { findTaskLogDir } from "../../../core/log-query.js";
import { loadRunEvents, readDoctorLogSnippet } from "../../../core/run-logs.js";
import type { TaskState } from "../../../core/state.js";
import { loadRunStateForProject } from "../../../core/state-store.js";

import type { LogsCommandContext } from "./index.js";

// =============================================================================
// COMMANDS
// =============================================================================

export async function runLogsFailuresCommand(
  ctx: LogsCommandContext,
  opts: { runId?: string; taskId?: string },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const events = loadRunEvents(runLogs.runId, runLogs.dir, {
    useIndex: ctx.useIndex,
    taskId: opts.taskId,
  });
  const groups = ctx.logQueryService.buildFailureGroups(events, runLogs.dir);

  if (groups.length === 0) {
    console.log(
      `No failures recorded for run ${runLogs.runId}${opts.taskId ? ` (task ${opts.taskId})` : ""}.`,
    );
    return;
  }

  console.log(`Failure digest for run ${runLogs.runId}:`);
  for (const group of groups) {
    const header = `${group.label} (${group.count})`;
    console.log(`- ${header}`);
    for (const example of group.examples) {
      const prefixParts = [
        ctx.logQueryService.formatTimestamp(example.ts),
        example.taskId ? `task ${example.taskId}` : null,
        example.attempt ? `attempt ${example.attempt}` : null,
      ].filter(Boolean);
      const prefix = prefixParts.join(" ");
      const snippet = example.snippet ? ` — ${example.snippet}` : "";
      console.log(`  • ${prefix}: ${example.message}${snippet}`);
    }
  }
}

export async function runLogsDoctorCommand(
  ctx: LogsCommandContext,
  opts: { runId?: string; taskId: string; attempt?: number },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
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

  if (!isValidAttemptNumber(opts.attempt)) {
    console.log("--attempt must be a positive integer.");
    process.exitCode = 1;
    return;
  }

  const selected = ctx.logQueryService.pickDoctorLog(doctorFiles, opts.attempt);
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

export async function runLogsSummarizeCommand(
  ctx: LogsCommandContext,
  opts: { runId?: string; taskId: string; useLlm?: boolean },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const summaryContext = await loadSummaryContext(ctx, runLogs.runId, runLogs.dir, opts.taskId);

  printSummaryHeader(summaryContext, runLogs.runId);
  printCodexTurnSummary(ctx, summaryContext.lastCodexTurn);
  printDoctorLogSummary(ctx, runLogs.dir, summaryContext.doctorLog);
  printValidatorSummaries(summaryContext.validatorSummaries);
  printHumanReview(ctx, runLogs.dir, summaryContext.taskState);
  console.log(`- Next action: ${summaryContext.nextAction}`);

  if (opts.useLlm) {
    await printLlmSummary(ctx, summaryContext, runLogs.runId, opts.taskId);
  }
}

// =============================================================================
// SUMMARY HELPERS
// =============================================================================

type SummaryContext = {
  taskId: string;
  taskState: TaskState | null;
  validatorSummaries: Awaited<
    ReturnType<LogsCommandContext["logQueryService"]["collectValidatorSummaries"]>
  >;
  doctorLog: ReturnType<typeof readDoctorLogSnippet>;
  lastCodexTurn: ReturnType<LogsCommandContext["logQueryService"]["findLastCodexTurn"]>;
  statusLine: string;
  nextAction: string;
};

async function loadSummaryContext(
  ctx: LogsCommandContext,
  runId: string,
  runLogsDir: string,
  taskId: string,
): Promise<SummaryContext> {
  const stateResolved = await loadRunStateForProject(ctx.projectName, runId, ctx.paths);
  const taskState = stateResolved?.state.tasks[taskId] ?? null;
  const events = loadRunEvents(runId, runLogsDir, {
    useIndex: ctx.useIndex,
    taskId,
  });

  const validatorSummaries = await ctx.logQueryService.collectValidatorSummaries(
    runLogsDir,
    taskId,
    taskState,
  );
  const lastDoctorAttempt = ctx.logQueryService.findLastAttempt(events, (event) =>
    event.type.startsWith("doctor."),
  );
  const doctorLog = readDoctorLogSnippet(runLogsDir, taskId, lastDoctorAttempt);
  const lastCodexTurn = ctx.logQueryService.findLastCodexTurn(events);
  const statusLine = ctx.logQueryService.buildStatusLine(taskState);
  const nextAction = ctx.logQueryService.suggestNextAction(
    taskState,
    validatorSummaries,
    doctorLog,
    lastCodexTurn,
  );

  return {
    taskId,
    taskState,
    validatorSummaries,
    doctorLog,
    lastCodexTurn,
    statusLine,
    nextAction,
  };
}

function printSummaryHeader(context: SummaryContext, runId: string): void {
  console.log(`Summary for task ${context.taskId} (run ${runId}):`);
  console.log(`- ${context.statusLine}`);
}

function printCodexTurnSummary(
  ctx: LogsCommandContext,
  codexTurn: SummaryContext["lastCodexTurn"],
): void {
  if (!codexTurn) {
    console.log("- Last Codex turn: not recorded");
    return;
  }

  const codexParts = compactParts([
    codexTurn.completedAt
      ? `completed ${ctx.logQueryService.formatTimestamp(codexTurn.completedAt)}`
      : codexTurn.startedAt
        ? `started ${ctx.logQueryService.formatTimestamp(codexTurn.startedAt)}`
        : null,
    codexTurn.attempt ? `attempt ${codexTurn.attempt}` : null,
    codexTurn.durationMs
      ? `turn duration ${ctx.logQueryService.formatDuration(codexTurn.durationMs)}`
      : null,
  ]);
  console.log(`- Last Codex turn: ${codexParts ?? "not recorded"}`);
}

function printDoctorLogSummary(
  ctx: LogsCommandContext,
  runLogsDir: string,
  doctorLog: SummaryContext["doctorLog"],
): void {
  if (!doctorLog) {
    console.log("- Last doctor log: not found");
    return;
  }

  console.log(`- Last doctor log (${ctx.logQueryService.relativeToRun(runLogsDir, doctorLog.path)}):`);
  console.log(indentMultiline(doctorLog.content));
}

function printValidatorSummaries(
  validatorSummaries: SummaryContext["validatorSummaries"],
): void {
  console.log("- Validator results:");
  if (validatorSummaries.length === 0) {
    console.log("  • none found");
    return;
  }

  for (const entry of validatorSummaries) {
    const summaryText = entry.summary ?? "(no summary available)";
    console.log(`  • ${entry.validator}: ${entry.status} — ${summaryText}`);
    if (entry.reportPath) {
      console.log(`    Report: ${entry.reportPath}`);
    }
  }
}

function printHumanReview(
  ctx: LogsCommandContext,
  runLogsDir: string,
  taskState: SummaryContext["taskState"],
): void {
  if (!taskState?.human_review) return;

  const review = taskState.human_review;
  console.log("");
  console.log(
    `Human review required by ${review.validator}: ${review.reason}${review.summary ? ` — ${review.summary}` : ""}`,
  );
  if (review.report_path) {
    console.log(`Report: ${ctx.logQueryService.relativeToRun(runLogsDir, review.report_path)}`);
  }
}

async function printLlmSummary(
  ctx: LogsCommandContext,
  summaryContext: SummaryContext,
  runId: string,
  taskId: string,
): Promise<void> {
  const llmResult = await ctx.logQueryService.runLlmSummary({
    runId,
    taskId,
    statusLine: summaryContext.statusLine,
    nextAction: summaryContext.nextAction,
    attempts: summaryContext.taskState?.attempts ?? null,
    lastError: summaryContext.taskState?.last_error ?? null,
    doctorText: summaryContext.doctorLog?.content ?? null,
    codex: summaryContext.lastCodexTurn,
    validators: summaryContext.validatorSummaries,
  });

  console.log("");
  if (llmResult.status === "ok") {
    console.log("LLM summary:");
    console.log(llmResult.text);
  } else {
    console.log(llmResult.message);
    if (llmResult.status === "error") {
      process.exitCode = 1;
    }
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function isValidAttemptNumber(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isInteger(value) && value > 0;
}

function compactParts(parts: Array<string | null | undefined>): string | undefined {
  const filtered = parts.filter((part) => part && part.trim().length > 0) as string[];
  return filtered.length > 0 ? filtered.join(" | ") : undefined;
}

function indentMultiline(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
