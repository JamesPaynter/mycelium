import type { ProjectConfig } from "../core/config.js";
import {
  loadRunStateForProject,
  summarizeRunState,
  type RunStatusSummary,
  type TaskStatusRow,
} from "../core/state-store.js";

export async function statusCommand(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string },
): Promise<void> {
  const resolved = await loadRunStateForProject(projectName, opts.runId);
  if (!resolved) {
    printRunNotFound(projectName, opts.runId);
    return;
  }

  const summary = summarizeRunState(resolved.state);
  printRunSummary(summary);
  printTaskTable(summary.tasks);
}

function printRunNotFound(projectName: string, requestedRunId?: string): void {
  const notFound = requestedRunId
    ? `Run ${requestedRunId} not found for project ${projectName}.`
    : `No runs found for project ${projectName}.`;

  console.log(notFound);
  console.log(`Start a run with: task-orchestrator run --project ${projectName}`);
  process.exitCode = 1;
}

function printRunSummary(summary: RunStatusSummary): void {
  console.log(`Run: ${summary.runId}`);
  console.log(`Status: ${summary.status}`);
  console.log(`Started: ${summary.startedAt}`);
  console.log(`Updated: ${summary.updatedAt}`);
  console.log("");
  console.log(formatBatchCounts(summary));
  console.log(formatTaskCounts(summary));
  console.log("");
}

function formatBatchCounts(summary: RunStatusSummary): string {
  const counts = summary.batchCounts;
  const parts = [
    `total=${counts.total}`,
    `pending=${counts.pending}`,
    `running=${counts.running}`,
    `complete=${counts.complete}`,
    `failed=${counts.failed}`,
  ];
  return `Batches: ${parts.join("  ")}`;
}

function formatTaskCounts(summary: RunStatusSummary): string {
  const counts = summary.taskCounts;
  const parts = [
    `total=${counts.total}`,
    `pending=${counts.pending}`,
    `running=${counts.running}`,
    `complete=${counts.complete}`,
    `failed=${counts.failed}`,
    `needs_rescope=${counts.needs_rescope}`,
    `skipped=${counts.skipped}`,
  ];
  return `Tasks: ${parts.join("  ")}`;
}

function printTaskTable(rows: TaskStatusRow[]): void {
  console.log("Tasks:");
  if (rows.length === 0) {
    console.log("  (no tasks tracked for this run)");
    return;
  }

  const idWidth = Math.max("ID".length, ...rows.map((r) => r.id.length));
  const statusWidth = Math.max("Status".length, ...rows.map((r) => r.status.length));
  const attemptsWidth = Math.max("Attempts".length, ...rows.map((r) => `${r.attempts}`.length));
  const branchWidth = Math.max(
    "Branch".length,
    ...rows.map((r) => (r.branch ? r.branch.length : 1)),
  );
  const hasThreadIds = rows.some((r) => r.threadId);
  const threadWidth = hasThreadIds
    ? Math.max("Thread".length, ...rows.map((r) => (r.threadId ? r.threadId.length : 1)))
    : 0;

  const headerParts = [
    pad("ID", idWidth),
    pad("Status", statusWidth),
    pad("Attempts", attemptsWidth),
    pad("Branch", branchWidth),
  ];
  if (hasThreadIds) {
    headerParts.push(pad("Thread", threadWidth));
  }
  console.log(`  ${headerParts.join("  ")}`);

  for (const row of rows) {
    const branch = row.branch ?? "-";
    const values = [
      pad(row.id, idWidth),
      pad(row.status, statusWidth),
      pad(`${row.attempts}`, attemptsWidth),
      pad(branch, branchWidth),
    ];
    if (hasThreadIds) {
      values.push(pad(row.threadId ?? "-", threadWidth));
    }
    console.log(`  ${values.join("  ")}`);
  }
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
