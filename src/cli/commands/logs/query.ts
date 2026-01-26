import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import {
  followJsonlFile,
  readJsonlFile,
  taskEventsLogPathForId,
  type JsonlFilter,
} from "../../../core/log-query.js";
import { listTaskEventLogs } from "../../../core/run-logs.js";

import type { LogsCommandContext, LogsCommandContextBuilder } from "./index.js";

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerLogsQueryCommand(
  logs: Command,
  buildContext: LogsCommandContextBuilder,
): void {
  logs
    .command("query")
    .description("Print JSONL events for orchestrator or a task")
    .option("--task <id>", "Task ID to filter")
    .option("--type <glob>", "Filter by event type (supports *)")
    .option("--follow", "Follow log output", false)
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await runLogsQuery(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
        typeGlob: opts.type,
        follow: opts.follow ?? false,
        useIndex: ctx.useIndex,
      });
    });
}

// =============================================================================
// COMMANDS
// =============================================================================

export async function runLogsQuery(
  ctx: LogsCommandContext,
  opts: {
    runId?: string;
    taskId?: string;
    typeGlob?: string;
    follow?: boolean;
    useIndex?: boolean;
  },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const filter: JsonlFilter = {};
  if (opts.taskId) filter.taskId = opts.taskId;
  if (opts.typeGlob) filter.typeGlob = opts.typeGlob;

  const preferIndex = opts.useIndex ?? false;
  if (preferIndex && opts.follow) {
    console.log("--use-index is ignored when --follow is set; streaming from log file instead.");
  }

  if (preferIndex && !opts.follow) {
    const indexedLines = ctx.logQueryService.queryLogsFromIndex(runLogs, filter);
    if (indexedLines.status === "ok") {
      for (const line of indexedLines.lines) {
        console.log(line);
      }
      return;
    }
    console.log(indexedLines.message);
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

export async function runLogsFollow(
  ctx: LogsCommandContext,
  opts: { runId?: string },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const orchestratorPath = path.join(runLogs.dir, "orchestrator.jsonl");
  const followers: Array<() => void> = [];
  const timers: NodeJS.Timeout[] = [];
  const seen = new Set<string>();

  const followTarget = (filePath: string, label: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);

    if (!fs.existsSync(filePath)) return;

    const relative = ctx.logQueryService.relativeToRun(runLogs.dir, filePath);
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
      const rel = ctx.logQueryService.relativeToRun(runLogs.dir, logPath);
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

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

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
