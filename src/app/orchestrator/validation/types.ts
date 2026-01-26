/**
 * Validation pipeline result types.
 * Purpose: provide normalized validator outputs for executor/state consumption.
 * Assumptions: results are post-normalization and include report references.
 * Usage: import ValidationOutcome from ValidationPipeline.runForTask().
 */

import type { ValidatorMode } from "../../../core/config.js";
import type { ValidatorId, ValidatorStatus } from "../../../core/state.js";

// =============================================================================
// RESULTS
// =============================================================================

export type ValidationResult = {
  validator: ValidatorId;
  status: ValidatorStatus;
  mode: ValidatorMode;
  summary: string | null;
  reportPath: string | null;
  trigger?: string;
};

export type ValidationBlock = ValidationResult & {
  reason: string;
};

export type ValidationOutcome = {
  taskId: string;
  results: ValidationResult[];
  blocked: ValidationBlock[];
};

export type DoctorValidationOutcome = {
  result: ValidationResult;
  blocked: ValidationBlock | null;
};
