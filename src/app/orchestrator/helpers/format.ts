/*
Pure formatting helpers shared by the orchestrator executor.
Assumes inputs are already validated or normalized.
*/

import type { DoctorCanarySummary } from "../../../core/state.js";
import type { DoctorCanaryResult } from "../../../validators/doctor-validator.js";

// =============================================================================
// DOCTOR CANARY HELPERS
// =============================================================================

export function formatDoctorCanaryEnvVar(envVar?: string): string {
  const trimmed = envVar?.trim();
  return `${trimmed && trimmed.length > 0 ? trimmed : "ORCH_CANARY"}=1`;
}

export function formatDoctorCanarySummary(canary: DoctorCanaryResult): string {
  if (canary.status === "skipped") {
    return `Canary: skipped (${canary.reason})`;
  }

  const envLabel = formatDoctorCanaryEnvVar(canary.envVar);
  return canary.status === "unexpected_pass"
    ? `Canary: unexpected pass with ${envLabel}`
    : `Canary: failed as expected with ${envLabel}`;
}

export function buildDoctorCanarySummary(
  canary?: DoctorCanaryResult,
): DoctorCanarySummary | undefined {
  if (!canary) return undefined;

  if (canary.status === "skipped") {
    return {
      status: "skipped",
      env_var: canary.envVar,
      reason: canary.reason,
    };
  }

  return {
    status: canary.status,
    env_var: canary.envVar,
    exit_code: canary.exitCode,
  };
}

// =============================================================================
// TEXT UTILITIES
// =============================================================================

export function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated]`;
}
