import { resetRunningTasks, type RunState } from "./state.js";

// =============================================================================
// CONSTANTS
// =============================================================================

export const STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;

// =============================================================================
// TYPES
// =============================================================================

export type StaleRecoveryOutcome = {
  recovered: boolean;
  reason?: string;
  lastUpdatedAt?: string;
  now?: string;
  ageMs?: number;
  resetTaskIds: string[];
};

// =============================================================================
// STALE DETECTION
// =============================================================================

export function recoverStaleRunState(
  state: RunState,
  opts: { now?: Date; staleAfterMs?: number } = {},
): StaleRecoveryOutcome {
  if (state.status !== "running") {
    return { recovered: false, resetTaskIds: [] };
  }

  const lastUpdatedAt = state.updated_at;
  const lastUpdatedMs = Date.parse(lastUpdatedAt);
  if (Number.isNaN(lastUpdatedMs)) {
    return { recovered: false, resetTaskIds: [] };
  }

  const now = opts.now ?? new Date();
  const ageMs = now.getTime() - lastUpdatedMs;
  if (ageMs < 0) {
    return { recovered: false, resetTaskIds: [] };
  }

  const staleAfterMs = opts.staleAfterMs ?? STALE_RUN_THRESHOLD_MS;
  if (ageMs < staleAfterMs) {
    return { recovered: false, resetTaskIds: [] };
  }

  const resetTaskIds = Object.entries(state.tasks)
    .filter(([, task]) => task.status === "running")
    .map(([taskId]) => taskId);
  const reason = buildStaleRecoveryReason(lastUpdatedAt, ageMs);

  state.status = "paused";
  resetRunningTasks(state, reason);

  return {
    recovered: true,
    reason,
    lastUpdatedAt,
    now: now.toISOString(),
    ageMs,
    resetTaskIds,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function buildStaleRecoveryReason(lastUpdatedAt: string, ageMs: number): string {
  const ageMinutes = Math.max(0, Math.round(ageMs / 60000));
  return `Stale recovery: no heartbeat since ${lastUpdatedAt} (${ageMinutes}m ago)`;
}
