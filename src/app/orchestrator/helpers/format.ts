/*
Pure formatting helpers shared by the orchestrator executor.
Assumes validator reports are already validated by their schemas.
*/

import type { DoctorCanarySummary } from "../../../core/state.js";
import type { ArchitectureValidationReport } from "../../../validators/architecture-validator.js";
import type { DoctorCanaryResult, DoctorValidationReport } from "../../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../../validators/style-validator.js";
import type { TestValidationReport } from "../../../validators/test-validator.js";


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
// REPORT SUMMARIES
// =============================================================================

export function summarizeTestReport(report: TestValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.coverage_gaps.length > 0) {
    parts.push(`Coverage gaps: ${report.coverage_gaps.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

export function summarizeStyleReport(report: StyleValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

export function summarizeArchitectureReport(report: ArchitectureValidationReport): string {
  const parts = [report.summary];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.recommendations.length > 0) {
    parts.push(`Recs: ${report.recommendations.length}`);
  }
  return parts.filter(Boolean).join(" | ");
}

export function summarizeDoctorReport(
  report: DoctorValidationReport,
  canary?: DoctorCanaryResult,
): string {
  const parts = [
    `Effective: ${report.effective ? "yes" : "no"}`,
    `Coverage: ${report.coverage_assessment}`,
  ];
  if (report.concerns.length > 0) {
    parts.push(`Concerns: ${report.concerns.length}`);
  }
  if (report.recommendations.length > 0) {
    parts.push(`Recs: ${report.recommendations.length}`);
  }
  if (canary) {
    parts.push(formatDoctorCanarySummary(canary));
  }
  return parts.join(" | ");
}


// =============================================================================
// TEXT UTILITIES
// =============================================================================

export function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated]`;
}
