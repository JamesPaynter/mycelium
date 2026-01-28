import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { formatErrorMessage } from "../core/error-format.js";
import {
  type UserFacingErrorCode,
  UserFacingError,
  USER_FACING_ERROR_CODES,
} from "../core/errors.js";
import {
  loadRunStateForProject,
  summarizeRunState,
  type HumanReviewRow,
  type RunStatusSummary,
  type TaskStatusRow,
} from "../core/state-store.js";

export async function statusCommand(
  projectName: string,
  config: ProjectConfig,
  opts: { runId?: string },
  appContext?: AppContext,
): Promise<void> {
  try {
    const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
    const resolved = await loadRunStateForProject(projectName, opts.runId, paths);
    if (!resolved) {
      printRunNotFound(projectName, opts.runId);
      return;
    }

    const summary = summarizeRunState(resolved.state);
    printRunSummary(summary);
    printBudgetSummary(summary);
    printHumanReviewQueue(summary.humanReview);
    printTaskTable(summary.tasks);
  } catch (error) {
    throw normalizeStatusCommandError(error);
  }
}

function printRunNotFound(projectName: string, requestedRunId?: string): void {
  const notFound = requestedRunId
    ? `Run ${requestedRunId} not found for project ${projectName}.`
    : `No runs found for project ${projectName}.`;

  console.log(notFound);
  console.log(`Start a run with: mycelium run --project ${projectName}`);
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

function printBudgetSummary(summary: RunStatusSummary): void {
  const tokensText = summary.tokensUsed.toLocaleString();
  console.log(`Tokens: ${tokensText}  Cost: ${formatCost(summary.estimatedCost)}`);
  console.log("Top spenders:");

  if (summary.topSpenders.length === 0) {
    console.log("  (no token usage recorded)");
    console.log("");
    return;
  }

  const idWidth = Math.max("ID".length, ...summary.topSpenders.map((r) => r.id.length));
  const tokenWidth = Math.max(
    "Tokens".length,
    ...summary.topSpenders.map((r) => `${r.tokensUsed}`.length),
  );
  const costWidth = Math.max(
    "Cost".length,
    ...summary.topSpenders.map((r) => formatCost(r.estimatedCost).length),
  );

  console.log(`  ${pad("ID", idWidth)}  ${pad("Tokens", tokenWidth)}  ${pad("Cost", costWidth)}`);

  for (const row of summary.topSpenders) {
    console.log(
      `  ${pad(row.id, idWidth)}  ${pad(`${row.tokensUsed}`, tokenWidth)}  ${pad(formatCost(row.estimatedCost), costWidth)}`,
    );
  }
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
    `validated=${counts.validated}`,
    `complete=${counts.complete}`,
    `failed=${counts.failed}`,
    `needs_human_review=${counts.needs_human_review}`,
    `needs_rescope=${counts.needs_rescope}`,
    `rescope_required=${counts.rescope_required}`,
    `skipped=${counts.skipped}`,
  ];
  return `Tasks: ${parts.join("  ")}`;
}

function printHumanReviewQueue(rows: HumanReviewRow[]): void {
  console.log("Human Review Queue:");
  if (rows.length === 0) {
    console.log("  (empty)");
    console.log("");
    return;
  }

  const idWidth = Math.max("ID".length, ...rows.map((r) => r.id.length));
  const validatorWidth = Math.max("Validator".length, ...rows.map((r) => r.validator.length));
  const reasonWidth = Math.max("Reason".length, ...rows.map((r) => r.reason.length));
  const summaryWidth = Math.max("Summary".length, ...rows.map((r) => (r.summary ?? "-").length));

  console.log(
    `  ${pad("ID", idWidth)}  ${pad("Validator", validatorWidth)}  ${pad("Reason", reasonWidth)}  ${pad("Summary", summaryWidth)}`,
  );
  for (const row of rows) {
    const summary = row.summary ?? "-";
    console.log(
      `  ${pad(row.id, idWidth)}  ${pad(row.validator, validatorWidth)}  ${pad(row.reason, reasonWidth)}  ${pad(summary, summaryWidth)}`,
    );
    if (row.reportPath) {
      console.log(`    Report: ${row.reportPath}`);
    }
  }
  console.log("");
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

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

// =============================================================================
// ERROR NORMALIZATION
// =============================================================================

const STATUS_COMMAND_FAILURE_TITLE = "Status command failed.";
const STATUS_COMMAND_RUN_STATE_HINT =
  "Run `mycelium resume` to recover the run, or `mycelium clean` to remove the run state.";

function normalizeStatusCommandError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) {
    return new UserFacingError({
      code: error.code,
      title: STATUS_COMMAND_FAILURE_TITLE,
      message: error.message,
      hint: error.hint ?? resolveStatusCommandHint(error),
      next: error.next,
      cause: error.cause ?? error,
    });
  }

  return new UserFacingError({
    code: resolveCommandErrorCode(error),
    title: STATUS_COMMAND_FAILURE_TITLE,
    message: formatErrorMessage(error),
    hint: resolveStatusCommandHint(error),
    cause: error,
  });
}

function resolveStatusCommandHint(error: unknown): string | undefined {
  if (isRunStateError(error)) {
    return STATUS_COMMAND_RUN_STATE_HINT;
  }

  return undefined;
}

function resolveCommandErrorCode(error: unknown): UserFacingErrorCode {
  if (error instanceof UserFacingError) {
    return error.code;
  }

  return USER_FACING_ERROR_CODES.unknown;
}

function isRunStateError(error: unknown): boolean {
  const userError = resolveUserFacingError(error);
  const title = userError?.title ?? "";
  if (title.toLowerCase().includes("run state")) {
    return true;
  }

  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("run state");
}

function resolveUserFacingError(error: unknown): UserFacingError | null {
  if (error instanceof UserFacingError) {
    return error;
  }

  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof UserFacingError) {
      return cause;
    }
  }

  return null;
}
