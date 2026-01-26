import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import fse from "fs-extra";

import { JsonlLogger, logOrchestratorEvent } from "./logger.js";
import { orchestratorLogPath, type PathsContext } from "./paths.js";
import { recoverStaleRunState, type StaleRecoveryOutcome } from "./run-state-recovery.js";
import { RunStateSchema, resetRunningTasks, type RunState } from "./state.js";
import { isoNow } from "./utils.js";

// =============================================================================
// TYPES
// =============================================================================

export type LoadRunStateOptions = {
  paths?: PathsContext;
  allowStaleRecovery?: boolean;
  staleAfterMs?: number;
  now?: Date;
};

// =============================================================================
// LOAD/SAVE
// =============================================================================

export async function loadRunState(
  statePath: string,
  opts: LoadRunStateOptions = {},
): Promise<RunState> {
  const raw = await fse.readFile(statePath, "utf8");
  const parsed = RunStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid run state at ${statePath}: ${parsed.error.toString()}`);
  }

  const state = parsed.data;
  if (opts.allowStaleRecovery !== false) {
    const recovery = recoverStaleRunState(state, {
      now: opts.now,
      staleAfterMs: opts.staleAfterMs,
    });
    if (recovery.recovered) {
      await saveRunState(statePath, state);
      logStaleRecovery(state, recovery, opts.paths);
    }
  }

  return state;
}

export async function saveRunState(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const parsed = RunStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`Cannot save run state: ${parsed.error.toString()}`);
  }

  const normalized: RunState = { ...parsed.data, updated_at: isoNow() };
  Object.assign(state, normalized);

  await writeStateFile(statePath, normalized, tempPath);
}

export async function recoverRunState(
  statePath: string,
  reason?: string,
  tempPath?: string,
): Promise<RunState> {
  const state = await loadRunState(statePath, { allowStaleRecovery: false });
  resetRunningTasks(state, reason);
  await saveRunState(statePath, state, tempPath);
  return state;
}

// =============================================================================
// LOGGING
// =============================================================================

function logStaleRecovery(
  state: RunState,
  recovery: StaleRecoveryOutcome,
  paths?: PathsContext,
): void {
  const logPath = orchestratorLogPath(state.project, state.run_id, paths);
  const logger = new JsonlLogger(logPath, { runId: state.run_id });

  try {
    logOrchestratorEvent(logger, "run.stale_recovery", {
      status: "paused",
      reason: recovery.reason ?? "stale recovery",
      last_updated_at: recovery.lastUpdatedAt ?? null,
      recovered_at: recovery.now ?? null,
      age_ms: recovery.ageMs ?? null,
      reset_task_count: recovery.resetTaskIds.length,
      reset_tasks: recovery.resetTaskIds,
    });
  } finally {
    logger.close();
  }
}

// =============================================================================
// FILE IO
// =============================================================================

async function writeStateFile(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const dir = path.dirname(statePath);
  await fse.ensureDir(dir);

  const tmpPath = tempPath ?? `${statePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "w");

  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fse.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}
