import type { ValidatorStatus } from "../../../core/state.js";

import type { ValidationBlock, ValidationResult } from "./types.js";

const VALIDATOR_LABELS: Record<ValidationResult["validator"], string> = {
  test: "Test",
  style: "Style",
  architecture: "Architecture",
  doctor: "Doctor",
};

export function buildBlockResult(result: ValidationResult): ValidationBlock | null {
  if (!shouldBlockValidator(result.mode, result.status)) {
    return null;
  }

  return {
    ...result,
    reason: buildBlockReason(result.validator, result.summary),
  };
}

function shouldBlockValidator(mode: ValidationResult["mode"], status: ValidatorStatus): boolean {
  if (mode !== "block") return false;
  return status === "fail" || status === "error";
}

function buildBlockReason(
  validator: ValidationResult["validator"],
  summary: string | null,
): string {
  const label = VALIDATOR_LABELS[validator] ?? "Validator";
  if (summary && summary.trim().length > 0) {
    return `${label} validator blocked merge: ${summary}`;
  }
  return `${label} validator blocked merge (mode=block)`;
}
