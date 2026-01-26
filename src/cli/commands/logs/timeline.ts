import { Command } from "commander";

import { loadRunEvents } from "../../../core/run-logs.js";
import { loadRunStateForProject } from "../../../core/state-store.js";

import type { LogsCommandContext, LogsCommandContextBuilder } from "./index.js";



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerLogsTimelineCommand(
  logs: Command,
  buildContext: LogsCommandContextBuilder,
): void {
  logs
    .command("timeline")
    .description("Show batch/task timeline with retries and merges")
    .action(async (_opts, command) => {
      const ctx = await buildContext(command);
      await runLogsTimeline(ctx, {
        runId: ctx.runId,
        useIndex: ctx.useIndex,
      });
    });
}



// =============================================================================
// COMMANDS
// =============================================================================

export async function runLogsTimeline(
  ctx: LogsCommandContext,
  opts: { runId?: string; useIndex?: boolean },
): Promise<void> {
  const runLogs = ctx.resolveRunLogsOrWarn(opts.runId);
  if (!runLogs) return;

  const events = loadRunEvents(runLogs.runId, runLogs.dir, { useIndex: opts.useIndex });
  if (events.length === 0) {
    console.log(`No events found for run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  const stateResolved = await loadRunStateForProject(
    ctx.projectName,
    runLogs.runId,
    ctx.paths,
  );
  const timeline = ctx.logQueryService.buildTimeline(events, stateResolved?.state ?? null);

  console.log(`Timeline for run ${runLogs.runId}:`);
  for (const entry of timeline.entries) {
    const detail = entry.details ? ` — ${entry.details}` : "";
    console.log(`- ${ctx.logQueryService.formatTimestamp(entry.ts)} ${entry.label}${detail}`);
  }

  const stats: string[] = [];
  if (timeline.runDurationMs !== undefined) {
    stats.push(`Run duration: ${ctx.logQueryService.formatDuration(timeline.runDurationMs)}`);
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
