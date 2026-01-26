/*
Validator summary helpers.
Purpose: provide a single source of truth for summarizing validator reports.
Assumptions: validator reports are already validated by their schemas.
*/

import type { ArchitectureValidationReport } from "../../../validators/architecture-validator.js";
import type {
  DoctorCanaryResult,
  DoctorValidationReport,
} from "../../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../../validators/style-validator.js";
import type { TestValidationReport } from "../../../validators/test-validator.js";
import { formatDoctorCanarySummary } from "../helpers/format.js";

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
