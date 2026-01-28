import { UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import {
  applyTaskStatusOverride as applyTaskStatusOverrideMutation,
  completeBatch as completeBatchMutation,
  createRunState,
  markTaskComplete as markTaskCompleteMutation,
  markTaskFailed as markTaskFailedMutation,
  markTaskNeedsHumanReview as markTaskNeedsHumanReviewMutation,
  markTaskNeedsRescope as markTaskNeedsRescopeMutation,
  markTaskRescopeRequired as markTaskRescopeRequiredMutation,
  markTaskRunning as markTaskRunningMutation,
  markTaskValidated as markTaskValidatedMutation,
  resetRunningTasks,
  resetTaskToPending as resetTaskToPendingMutation,
  startBatch as startBatchMutation,
} from "./state-mutations.js";

export {
  AttemptUsageSchema,
  BatchStateSchema,
  BatchStatusSchema,
  CheckpointCommitSchema,
  ControlPlaneSnapshotSchema,
  DoctorCanarySummarySchema,
  HumanReviewSchema,
  RunStateSchema,
  RunStatusSchema,
  TaskOverrideStatusSchema,
  TaskStateSchema,
  TaskStatusSchema,
  ValidatorIdSchema,
  ValidatorResultSchema,
  ValidatorStatusSchema,
} from "./state-schema.js";
export type {
  AttemptUsage,
  BatchState,
  BatchStatus,
  CheckpointCommit,
  ControlPlaneSnapshot,
  DoctorCanarySummary,
  HumanReview,
  RunState,
  RunStatus,
  TaskOverrideStatus,
  TaskState,
  TaskStatus,
  ValidatorId,
  ValidatorResult,
  ValidatorStatus,
} from "./state-schema.js";

// =============================================================================
// RUN STATE ERROR NORMALIZATION
// =============================================================================

const RUN_STATE_RECOVERY_HINT =
  "Run `mycelium resume` to recover the run, or `mycelium clean` to remove the run state.";
const INVALID_STATE_TRANSITION_TITLE = "Run state transition invalid.";

function formatStateTransitionMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }

  if (typeof error === "string") {
    const message = error.trim();
    if (message.length > 0) {
      return message;
    }
  }

  if (error !== null && error !== undefined) {
    const message = String(error).trim();
    if (message.length > 0) {
      return message;
    }
  }

  return "Run state transition rejected.";
}

function createInvalidStateTransitionError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) {
    return error;
  }

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: INVALID_STATE_TRANSITION_TITLE,
    message: formatStateTransitionMessage(error),
    hint: RUN_STATE_RECOVERY_HINT,
    cause: error,
  });
}

function wrapStateMutation<Args extends unknown[], Result>(
  mutation: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args): Result => {
    try {
      return mutation(...args);
    } catch (error) {
      throw createInvalidStateTransitionError(error);
    }
  };
}

// =============================================================================
// RUN STATE MUTATIONS
// =============================================================================

export { createRunState, resetRunningTasks };

export const applyTaskStatusOverride = wrapStateMutation(applyTaskStatusOverrideMutation);
export const completeBatch = wrapStateMutation(completeBatchMutation);
export const markTaskComplete = wrapStateMutation(markTaskCompleteMutation);
export const markTaskFailed = wrapStateMutation(markTaskFailedMutation);
export const markTaskNeedsHumanReview = wrapStateMutation(markTaskNeedsHumanReviewMutation);
export const markTaskNeedsRescope = wrapStateMutation(markTaskNeedsRescopeMutation);
export const markTaskRescopeRequired = wrapStateMutation(markTaskRescopeRequiredMutation);
export const markTaskRunning = wrapStateMutation(markTaskRunningMutation);
export const markTaskValidated = wrapStateMutation(markTaskValidatedMutation);
export const resetTaskToPending = wrapStateMutation(resetTaskToPendingMutation);
export const startBatch = wrapStateMutation(startBatchMutation);
