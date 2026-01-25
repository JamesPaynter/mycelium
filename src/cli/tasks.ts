import path from "node:path";

import { Command } from "commander";

import type { ProjectConfig } from "../core/config.js";
import { TaskError } from "../core/errors.js";
import { loadTaskSpecs } from "../core/task-loader.js";
import {
  importLedgerFromRunState,
  loadTaskLedger,
  type TaskLedgerEntry,
  type TaskLedgerImportResult,
} from "../core/task-ledger.js";
import { StateStore, loadRunStateForProject } from "../core/state-store.js";
import {
  applyTaskStatusOverride,
  TaskOverrideStatusSchema,
  type TaskOverrideStatus,
} from "../core/state.js";
import type { TaskSpec } from "../core/task-manifest.js";
import { loadConfigForCli } from "./config.js";


// =============================================================================
// TYPES
// =============================================================================

type TaskImportOptions = {
  runId: string;
};

type TaskSetStatusOptions = {
  runId?: string;
  taskId: string;
  status: TaskOverrideStatus;
  force?: boolean;
};

type TaskLedgerListRow = {
  taskId: string;
  status: string;
  runId: string;
  mergeCommit: string;
  completedAt: string;
};


// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerTasksCommand(program: Command): void {
  const tasks = program.command("tasks").description("Task operator utilities");

  tasks
    .command("import-run")
    .description("Import completed tasks from a prior run into the ledger")
    .argument("<runId>", "Run ID to import")
    .option("--project <name>", "Project name (default: repo folder name)")
    .action(async (runId: string, opts, command) => {
      const { config, projectName } = await resolveProjectContext(command, opts.project);
      await tasksImportRunCommand(projectName, config, { runId });
    });

  tasks
    .command("set-status")
    .description("Override task status for a run")
    .argument("<taskId>", "Task ID")
    .requiredOption("--status <status>", "New status (pending|complete|skipped)")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--force", "Allow overriding running tasks", false)
    .option("--project <name>", "Project name (default: repo folder name)")
    .action(async (taskId: string, opts, command) => {
      const { config, projectName } = await resolveProjectContext(command, opts.project);
      const parsedStatus = parseOverrideStatus(opts.status);
      if (!parsedStatus) {
        console.log("Status must be one of: pending, complete, skipped.");
        process.exitCode = 1;
        return;
      }

      await tasksSetStatusCommand(projectName, config, {
        runId: opts.runId,
        taskId,
        status: parsedStatus,
        force: opts.force ?? false,
      });
    });

  const ledger = tasks
    .command("ledger")
    .description("Inspect the task ledger")
    .option("--project <name>", "Project name (default: repo folder name)");

  ledger
    .command("list")
    .description("List ledger entries")
    .option("--project <name>", "Project name (default: repo folder name)")
    .action(async (opts, command) => {
      const { config, projectName } = await resolveProjectContext(command, opts.project);
      await tasksLedgerListCommand(projectName, config);
    });

  ledger
    .command("get")
    .description("Show a ledger entry as JSON")
    .argument("<taskId>", "Task ID")
    .option("--project <name>", "Project name (default: repo folder name)")
    .action(async (taskId: string, opts, command) => {
      const { config, projectName } = await resolveProjectContext(command, opts.project);
      await tasksLedgerGetCommand(projectName, config, { taskId });
    });

  ledger.action(async (opts, command) => {
    const { config, projectName } = await resolveProjectContext(command, opts.project);
    await tasksLedgerListCommand(projectName, config);
  });
}


// =============================================================================
// COMMANDS
// =============================================================================

export async function tasksImportRunCommand(
  projectName: string,
  config: ProjectConfig,
  opts: TaskImportOptions,
): Promise<void> {
  const store = new StateStore(projectName, opts.runId);
  if (!(await store.exists())) {
    console.log(`Run ${opts.runId} not found for project ${projectName}.`);
    process.exitCode = 1;
    return;
  }

  const state = await store.load();
  const tasks = await loadTaskCatalogOrExit(config);
  if (!tasks) return;

  const result = await importLedgerFromRunState({
    projectName,
    repoPath: config.repo_path,
    runId: opts.runId,
    tasks,
    state,
    tasksRoot: resolveTasksRoot(config),
  });

  printImportSummary(opts.runId, result);
}

export async function tasksSetStatusCommand(
  projectName: string,
  _config: ProjectConfig,
  opts: TaskSetStatusOptions,
): Promise<void> {
  const resolved = await loadRunStateForProject(projectName, opts.runId);
  if (!resolved) {
    const notFound = opts.runId
      ? `Run ${opts.runId} not found for project ${projectName}.`
      : `No runs found for project ${projectName}.`;
    console.log(notFound);
    process.exitCode = 1;
    return;
  }

  const task = resolved.state.tasks[opts.taskId];
  if (!task) {
    console.log(`Task ${opts.taskId} not found in run ${resolved.runId}.`);
    process.exitCode = 1;
    return;
  }

  const previousStatus = task.status;
  try {
    applyTaskStatusOverride(resolved.state, opts.taskId, {
      status: opts.status,
      force: opts.force ?? false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(detail);
    process.exitCode = 1;
    return;
  }

  const store = new StateStore(projectName, resolved.runId);
  await store.save(resolved.state);

  console.log(
    `Updated task ${opts.taskId}: ${previousStatus} -> ${opts.status} (run ${resolved.runId}).`,
  );
}

export async function tasksLedgerListCommand(
  projectName: string,
  _config: ProjectConfig,
): Promise<void> {
  const ledger = await loadTaskLedger(projectName);
  if (!ledger || Object.keys(ledger.tasks).length === 0) {
    console.log(`No ledger entries found for project ${projectName}.`);
    return;
  }

  const rows = buildLedgerRows(ledger.tasks);
  printLedgerRows(projectName, rows);
}

export async function tasksLedgerGetCommand(
  projectName: string,
  _config: ProjectConfig,
  opts: { taskId: string },
): Promise<void> {
  const ledger = await loadTaskLedger(projectName);
  if (!ledger) {
    console.log(`No ledger found for project ${projectName}.`);
    process.exitCode = 1;
    return;
  }

  const entry = ledger.tasks[opts.taskId];
  if (!entry) {
    console.log(`Task ${opts.taskId} not found in ledger for project ${projectName}.`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(entry, null, 2));
}


// =============================================================================
// OUTPUT
// =============================================================================

function printImportSummary(runId: string, result: TaskLedgerImportResult): void {
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

function buildLedgerRows(entries: Record<string, TaskLedgerEntry>): TaskLedgerListRow[] {
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

function printLedgerRows(projectName: string, rows: TaskLedgerListRow[]): void {
  const headers = {
    taskId: "Task",
    status: "Status",
    runId: "Run",
    mergeCommit: "Merge",
    completedAt: "Completed",
  };

  const widths = {
    taskId: columnWidth(rows.map((row) => row.taskId), headers.taskId),
    status: columnWidth(rows.map((row) => row.status), headers.status),
    runId: columnWidth(rows.map((row) => row.runId), headers.runId),
    mergeCommit: columnWidth(rows.map((row) => row.mergeCommit), headers.mergeCommit),
    completedAt: columnWidth(rows.map((row) => row.completedAt), headers.completedAt),
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
      )}  ${pad(row.mergeCommit, widths.mergeCommit)}  ${pad(
        row.completedAt,
        widths.completedAt,
      )}`,
    );
  }
}


// =============================================================================
// UTILITIES
// =============================================================================

async function resolveProjectContext(
  command: Command,
  projectOption?: string,
): Promise<{ config: ProjectConfig; projectName: string }> {
  const globals = command.optsWithGlobals() as { config?: string; project?: string };
  const { config, projectName } = await loadConfigForCli({
    projectName: projectOption ?? globals.project,
    explicitConfigPath: globals.config,
    initIfMissing: true,
  });

  return { config, projectName };
}

function parseOverrideStatus(raw: string): TaskOverrideStatus | null {
  const normalized = raw.trim().toLowerCase();
  const parsed = TaskOverrideStatusSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function resolveTasksRoot(config: ProjectConfig): string {
  return path.resolve(config.repo_path, config.tasks_dir);
}

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
  return parsed.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

async function loadTaskCatalogOrExit(config: ProjectConfig): Promise<TaskSpec[] | null> {
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
