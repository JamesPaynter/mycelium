import path from "node:path";

import type { Command } from "commander";

import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { TaskError } from "../core/errors.js";
import type { PathsContext } from "../core/paths.js";
import { TaskOverrideStatusSchema, type TaskOverrideStatus } from "../core/state.js";
import type { TaskLedgerEntry, TaskLedgerImportResult } from "../core/task-ledger.js";
import { loadTaskSpecs } from "../core/task-loader.js";
import type { TaskSpec } from "../core/task-manifest.js";

import { loadConfigForCli } from "./config.js";

// =============================================================================
// TYPES
// =============================================================================

type TaskLedgerListRow = {
  taskId: string;
  status: string;
  runId: string;
  mergeCommit: string;
  completedAt: string;
};

// =============================================================================
// CONTEXT
// =============================================================================

export async function resolveProjectContext(
  command: Command,
  projectOption?: string,
): Promise<{ config: ProjectConfig; projectName: string; paths: PathsContext }> {
  const globals = command.optsWithGlobals() as { config?: string; project?: string };
  const { appContext, config, projectName } = await loadConfigForCli({
    projectName: projectOption ?? globals.project,
    explicitConfigPath: globals.config,
    initIfMissing: true,
  });

  return { config, projectName, paths: appContext.paths };
}

export function parseOverrideStatus(raw: string): TaskOverrideStatus | null {
  const normalized = raw.trim().toLowerCase();
  const parsed = TaskOverrideStatusSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export function resolvePathsContext(config: ProjectConfig, paths?: PathsContext): PathsContext {
  return paths ?? createAppPathsContext({ repoPath: config.repo_path });
}

export function resolveTasksRoot(config: ProjectConfig): string {
  return path.resolve(config.repo_path, config.tasks_dir);
}

// =============================================================================
// OUTPUT
// =============================================================================

export function printImportSummary(runId: string, result: TaskLedgerImportResult): void {
  const imported = sortTaskIds(result.imported);
  const skipped = sortSkipDetails(result.skippedDetails);

  if (imported.length === 0 && skipped.length === 0) {
    console.log(`No completed tasks found to import from run ${runId}.`);
    return;
  }

  console.log(`Imported ${imported.length} task(s) from run ${runId}.`);
  for (const taskId of imported) {
    console.log(`- ${taskId}`);
  }

  if (skipped.length === 0) {
    return;
  }

  console.log(`Skipped ${skipped.length} task(s):`);
  for (const entry of skipped) {
    console.log(`- ${entry.taskId}: ${entry.reason}`);
  }
}

export function buildLedgerRows(entries: Record<string, TaskLedgerEntry>): TaskLedgerListRow[] {
  return Object.values(entries)
    .map((entry) => ({
      taskId: entry.taskId,
      status: entry.status,
      runId: entry.runId ?? "-",
      mergeCommit: entry.mergeCommit ?? "-",
      completedAt: entry.completedAt ? formatTimestamp(entry.completedAt) : "-",
    }))
    .sort((a, b) =>
      a.taskId.localeCompare(b.taskId, undefined, { numeric: true, sensitivity: "base" }),
    );
}

export function printLedgerRows(projectName: string, rows: TaskLedgerListRow[]): void {
  const headers = {
    taskId: "Task",
    status: "Status",
    runId: "Run",
    mergeCommit: "Merge",
    completedAt: "Completed",
  };

  const widths = {
    taskId: columnWidth(
      rows.map((row) => row.taskId),
      headers.taskId,
    ),
    status: columnWidth(
      rows.map((row) => row.status),
      headers.status,
    ),
    runId: columnWidth(
      rows.map((row) => row.runId),
      headers.runId,
    ),
    mergeCommit: columnWidth(
      rows.map((row) => row.mergeCommit),
      headers.mergeCommit,
    ),
    completedAt: columnWidth(
      rows.map((row) => row.completedAt),
      headers.completedAt,
    ),
  };

  console.log(`Ledger entries for project ${projectName}:`);
  console.log(
    `${pad(headers.taskId, widths.taskId)}  ${pad(headers.status, widths.status)}  ${pad(
      headers.runId,
      widths.runId,
    )}  ${pad(headers.mergeCommit, widths.mergeCommit)}  ${pad(
      headers.completedAt,
      widths.completedAt,
    )}`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.taskId, widths.taskId)}  ${pad(row.status, widths.status)}  ${pad(
        row.runId,
        widths.runId,
      )}  ${pad(row.mergeCommit, widths.mergeCommit)}  ${pad(row.completedAt, widths.completedAt)}`,
    );
  }
}

// =============================================================================
// UTILITIES
// =============================================================================

function sortTaskIds(taskIds: string[]): string[] {
  return [...taskIds].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function sortSkipDetails(
  details: TaskLedgerImportResult["skippedDetails"],
): TaskLedgerImportResult["skippedDetails"] {
  return [...details].sort((a, b) =>
    a.taskId.localeCompare(b.taskId, undefined, { numeric: true, sensitivity: "base" }),
  );
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
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

// =============================================================================
// TASK LOADING
// =============================================================================

export async function loadTaskCatalogOrExit(config: ProjectConfig): Promise<TaskSpec[] | null> {
  try {
    const { tasks } = await loadTaskSpecs(config.repo_path, config.tasks_dir);
    return tasks;
  } catch (error) {
    if (error instanceof TaskError) {
      console.log(error.message);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}
