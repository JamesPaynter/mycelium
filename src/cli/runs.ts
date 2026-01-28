import { Command } from "commander";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { formatErrorMessage } from "../core/error-format.js";
import {
  type UserFacingErrorCode,
  UserFacingError,
  USER_FACING_ERROR_CODES,
} from "../core/errors.js";
import { listRunHistoryEntries, type RunHistoryEntry } from "../core/run-history.js";

import { loadConfigForCli } from "./config.js";

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerRunsCommand(program: Command): void {
  const runs = program.command("runs").description("List runs recorded for a project");

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

      await runsListCommand(
        projectName,
        config,
        {
          limit: limit.value,
          json: opts.json ?? false,
        },
        appContext,
      );
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
  try {
    const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
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
  } catch (error) {
    throw normalizeRunsCommandError(error);
  }
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
    runId: columnWidth(
      rows.map((row) => row.runId),
      headers.runId,
    ),
    status: columnWidth(
      rows.map((row) => row.status),
      headers.status,
    ),
    startedAt: columnWidth(
      rows.map((row) => row.startedAt),
      headers.startedAt,
    ),
    updatedAt: columnWidth(
      rows.map((row) => row.updatedAt),
      headers.updatedAt,
    ),
    tasks: columnWidth(
      rows.map((row) => row.tasks),
      headers.tasks,
    ),
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
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

// =============================================================================
// ERROR NORMALIZATION
// =============================================================================

const RUNS_COMMAND_FAILURE_TITLE = "Runs command failed.";
const RUNS_COMMAND_RUN_STATE_HINT =
  "Run `mycelium resume` to recover the run, or `mycelium clean` to remove the run state.";

function normalizeRunsCommandError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) {
    return new UserFacingError({
      code: error.code,
      title: RUNS_COMMAND_FAILURE_TITLE,
      message: error.message,
      hint: error.hint ?? resolveRunsCommandHint(error),
      next: error.next,
      cause: error.cause ?? error,
    });
  }

  return new UserFacingError({
    code: resolveCommandErrorCode(error),
    title: RUNS_COMMAND_FAILURE_TITLE,
    message: formatErrorMessage(error),
    hint: resolveRunsCommandHint(error),
    cause: error,
  });
}

function resolveRunsCommandHint(error: unknown): string | undefined {
  if (isRunStateError(error)) {
    return RUNS_COMMAND_RUN_STATE_HINT;
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
