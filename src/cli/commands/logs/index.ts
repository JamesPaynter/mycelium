import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { LogQueryService } from "../../../app/services/log-query-service.js";
import type { ProjectConfig } from "../../../core/config.js";
import { findTaskLogDir } from "../../../core/log-query.js";
import type { PathsContext } from "../../../core/paths.js";
import { resolveRunLogsDir } from "../../../core/paths.js";
import { loadRunEvents, readDoctorLogSnippet } from "../../../core/run-logs.js";
import { loadRunStateForProject } from "../../../core/state-store.js";
import { loadConfigForCli } from "../../config.js";

import { registerLogsQueryCommand, runLogsFollow, runLogsQuery } from "./query.js";
import { registerLogsSearchCommand } from "./search.js";
import { registerLogsTimelineCommand } from "./timeline.js";



// =============================================================================
// TYPES
// =============================================================================

export type LogsCommandContext = {
  projectName: string;
  runId?: string;
  config: ProjectConfig;
  useIndex: boolean;
  paths: PathsContext;
  logQueryService: LogQueryService;
  resolveRunLogsOrWarn: (runId?: string) => { runId: string; dir: string } | null;
};

export type LogsCommandContextBuilder = (command: Command) => Promise<LogsCommandContext>;



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description("Inspect orchestrator and task logs")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--use-index", "Query logs via SQLite index (builds if missing)", false)
    .option("--follow", "Follow orchestrator + task logs", false);

  const buildContext: LogsCommandContextBuilder = (command) => buildLogsCommandContext(command);

  registerLogsQueryCommand(logs, buildContext);
  registerLogsSearchCommand(logs, buildContext);
  registerLogsTimelineCommand(logs, buildContext);

  logs
    .command("failures")
    .description("Summarize failures for a run")
    .option("--task <id>", "Limit to a specific task")
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsFailuresCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
      });
    });

  logs
    .command("doctor")
    .description("Show raw doctor output for a task attempt")
    .requiredOption("--task <id>", "Task ID")
    .option("--attempt <n>", "Attempt number", (v: string) => parseInt(v, 10))
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsDoctorCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
        attempt: opts.attempt,
      });
    });

  logs
    .command("summarize")
    .description("Summarize validator results for a task")
    .requiredOption("--task <id>", "Task ID")
    .option("--llm", "Use LLM to summarize validator failures", false)
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await logsSummarizeCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
        useLlm: opts.llm ?? false,
      });
    });

  logs.action(async (opts, command) => {
    const ctx = await buildContext(command);
    if (opts.follow) {
      await runLogsFollow(ctx, { runId: ctx.runId });
      return;
    }
    await runLogsQuery(ctx, {
      runId: ctx.runId,
      useIndex: ctx.useIndex,
    });
  });
}



// =============================================================================
// COMMANDS
// =============================================================================

async function logsFailuresCommand(
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

async function logsDoctorCommand(
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

  if (opts.attempt !== undefined && (!Number.isInteger(opts.attempt) || opts.attempt <= 0)) {
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

async function logsSummarizeCommand(
  ctx: LogsCommandContext,
  opts: { runId?: string; taskId: string; useLlm?: boolean },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const stateResolved = await loadRunStateForProject(ctx.projectName, runLogs.runId, ctx.paths);
  const taskState = stateResolved?.state.tasks[opts.taskId] ?? null;
  const events = loadRunEvents(runLogs.runId, runLogs.dir, {
    useIndex: ctx.useIndex,
    taskId: opts.taskId,
  });

  const validatorSummaries = await ctx.logQueryService.collectValidatorSummaries(
    runLogs.dir,
    opts.taskId,
    taskState,
  );
  const lastDoctorAttempt = ctx.logQueryService.findLastAttempt(events, (event) =>
    event.type.startsWith("doctor."),
  );
  const doctorLog = readDoctorLogSnippet(runLogs.dir, opts.taskId, lastDoctorAttempt);
  const lastCodexTurn = ctx.logQueryService.findLastCodexTurn(events);
  const statusLine = ctx.logQueryService.buildStatusLine(taskState);
  const nextAction = ctx.logQueryService.suggestNextAction(
    taskState,
    validatorSummaries,
    doctorLog,
    lastCodexTurn,
  );

  console.log(`Summary for task ${opts.taskId} (run ${runLogs.runId}):`);
  console.log(`- ${statusLine}`);

  if (lastCodexTurn) {
    const codexParts = compactParts([
      lastCodexTurn.completedAt
        ? `completed ${ctx.logQueryService.formatTimestamp(lastCodexTurn.completedAt)}`
        : lastCodexTurn.startedAt
          ? `started ${ctx.logQueryService.formatTimestamp(lastCodexTurn.startedAt)}`
          : null,
      lastCodexTurn.attempt ? `attempt ${lastCodexTurn.attempt}` : null,
      lastCodexTurn.durationMs
        ? `turn duration ${ctx.logQueryService.formatDuration(lastCodexTurn.durationMs)}`
        : null,
    ]);
    console.log(`- Last Codex turn: ${codexParts ?? "not recorded"}`);
  } else {
    console.log("- Last Codex turn: not recorded");
  }

  if (doctorLog) {
    console.log(`- Last doctor log (${ctx.logQueryService.relativeToRun(runLogs.dir, doctorLog.path)}):`);
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
      console.log(`Report: ${ctx.logQueryService.relativeToRun(runLogs.dir, review.report_path)}`);
    }
  }

  console.log(`- Next action: ${nextAction}`);

  if (opts.useLlm) {
    const llmResult = await ctx.logQueryService.runLlmSummary({
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
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function buildLogsCommandContext(command: Command): Promise<LogsCommandContext> {
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
    logQueryService: new LogQueryService(config),
    resolveRunLogsOrWarn: (runId?: string) =>
      resolveRunLogsOrWarn(projectName, runId, appContext.paths),
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
