/**
 * Task failure policy helpers.
 * Purpose: centralize reset-to-pending decisions for worker failures.
 */

import type { TaskFailurePolicy } from "../../../core/config.js";
import type { WorkerRunnerResult } from "../workers/worker-runner.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export function shouldResetTaskToPending(input: {
  policy: TaskFailurePolicy;
  result: WorkerRunnerResult;
}): boolean {
  if (input.result.resetToPending) {
    return true;
  }

  if (input.result.success) {
    return false;
  }

  return input.policy === "retry";
}
