import { Command } from "commander";

import { searchLogs, type LogSearchResult } from "../../../core/log-query.js";

import type { LogsCommandContext, LogsCommandContextBuilder } from "./index.js";



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerLogsSearchCommand(
  logs: Command,
  buildContext: LogsCommandContextBuilder,
): void {
  logs
    .command("search")
    .description("Search across run logs for a substring (grep-style)")
    .argument("<pattern>", "String to search for")
    .option("--task <id>", "Limit search to a specific task")
    .action(async (pattern, opts, command) => {
      const ctx = await buildContext(command);
      await runLogsSearch(ctx, {
        runId: ctx.runId,
        pattern,
        taskId: opts.task,
        useIndex: ctx.useIndex,
      });
    });
}



// =============================================================================
// COMMANDS
// =============================================================================

export async function runLogsSearch(
  ctx: LogsCommandContext,
  opts: { runId?: string; pattern: string; taskId?: string; useIndex?: boolean },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const preferIndex = opts.useIndex ?? false;
  let matches: LogSearchResult[];
  if (preferIndex) {
    const indexed = ctx.logQueryService.searchLogsFromIndex(runLogs, opts.pattern, opts.taskId);
    if (indexed.status === "ok") {
      matches = indexed.matches;
    } else {
      console.log(indexed.message);
      matches = searchLogs(runLogs.dir, opts.pattern, { taskId: opts.taskId });
    }
  } else {
    matches = searchLogs(runLogs.dir, opts.pattern, { taskId: opts.taskId });
  }
  if (matches.length === 0) {
    console.log(`No matches for "${opts.pattern}" in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  for (const match of matches) {
    const relPath = ctx.logQueryService.relativeToRun(runLogs.dir, match.filePath);
    console.log(`${relPath}:${match.lineNumber}:${match.line}`);
  }
}
