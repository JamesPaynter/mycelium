import { Command } from "commander";

import type { AppContext } from "../app/context.js";
import type { ProjectConfig } from "../core/config.js";
import { createPathsContext } from "../core/paths.js";
import { listRunHistoryEntries, type RunHistoryEntry } from "../core/run-history.js";
import { loadConfigForCli } from "./config.js";


// =============================================================================
// TYPES
// =============================================================================

type RunsListOptions = {
  project?: string;
  limit?: number;
  json?: boolean;
};


// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerRunsCommand(program: Command): void {
  const runs = program
    .command("runs")
    .description("List runs recorded for a project");

  runs
    .command("list")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--limit <n>", "Maximum number of runs", (v: string) => parseInt(v, 10))
    .option("--json", "Emit JSON output", false)
    .action(async (opts, command) => {
      const globals = command.optsWithGlobals() as { config?: string };
      const { appContext, config, projectName } = await loadConfigForCli({
        projectName: opts.project,
        explicitConfigPath: globals.config,
        initIfMissing: true,
      });

      const limit = normalizeLimit(opts.limit);
      if (!limit.ok) {
        console.error("Limit must be a positive integer.");
        process.exitCode = 1;
        return;
      }

      await runsListCommand(projectName, config, {
        limit: limit.value,
        json: opts.json ?? false,
      }, appContext);
    });
}


// =============================================================================
// COMMANDS
// =============================================================================

export async function runsListCommand(
  projectName: string,
  config: ProjectConfig,
  opts: { limit?: number; json?: boolean },
  appContext?: AppContext,
): Promise<void> {
  const paths = appContext?.paths ?? createPathsContext({ repoPath: config.repo_path });
  const runs = await listRunHistoryEntries(projectName, { limit: opts.limit }, paths);

  if (opts.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  if (runs.length === 0) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  printRunList(projectName, runs);
}


// =============================================================================
// OUTPUT
// =============================================================================

function printRunList(projectName: string, runs: RunHistoryEntry[]): void {
  const rows = runs.map((run) => ({
    runId: run.runId,
    status: run.status,
    startedAt: formatTimestamp(run.startedAt),
    updatedAt: formatTimestamp(run.updatedAt),
    tasks: String(run.taskCount),
  }));

  const headers = {
    runId: "Run",
    status: "Status",
    startedAt: "Started",
    updatedAt: "Updated",
    tasks: "Tasks",
  };

  const widths = {
    runId: columnWidth(rows.map((row) => row.runId), headers.runId),
    status: columnWidth(rows.map((row) => row.status), headers.status),
    startedAt: columnWidth(rows.map((row) => row.startedAt), headers.startedAt),
    updatedAt: columnWidth(rows.map((row) => row.updatedAt), headers.updatedAt),
    tasks: columnWidth(rows.map((row) => row.tasks), headers.tasks),
  };

  console.log(`Runs for project ${projectName}:`);
  console.log(
    `${pad(headers.runId, widths.runId)}  ${pad(headers.status, widths.status)}  ${pad(
      headers.startedAt,
      widths.startedAt,
    )}  ${pad(headers.updatedAt, widths.updatedAt)}  ${pad(headers.tasks, widths.tasks)}`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.runId, widths.runId)}  ${pad(row.status, widths.status)}  ${pad(
        row.startedAt,
        widths.startedAt,
      )}  ${pad(row.updatedAt, widths.updatedAt)}  ${pad(row.tasks, widths.tasks)}`,
    );
  }
}


// =============================================================================
// UTILITIES
// =============================================================================

function normalizeLimit(limit?: number): { ok: true; value?: number } | { ok: false } {
  if (limit === undefined) {
    return { ok: true, value: undefined };
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false };
  }

  return { ok: true, value: limit };
}

function columnWidth(values: string[], header: string): number {
  const lengths = values.map((value) => value.length);
  return Math.max(header.length, ...lengths, 4);
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function formatTimestamp(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
