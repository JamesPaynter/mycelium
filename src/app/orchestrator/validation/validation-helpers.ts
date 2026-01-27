import path from "node:path";

import fse from "fs-extra";

import type { PathsContext } from "../../../core/paths.js";
import { runLogsDir } from "../../../core/paths.js";
import type { ValidatorStatus } from "../../../core/state.js";
import { type ArchitectureValidationReport } from "../../../validators/architecture-validator.js";
import { type StyleValidationReport } from "../../../validators/style-validator.js";
import { type TestValidationReport } from "../../../validators/test-validator.js";

import {
  summarizeArchitectureReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "./summaries.js";
import type { ValidationResult } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export type ValidatorRunSummary = {
  status: ValidatorStatus;
  summary: string | null;
  reportPath: string | null;
  trigger?: string;
};

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

export async function summarizeTestValidatorResult(
  reportPath: string,
  result: TestValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<TestValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus = resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeTestReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Test validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

export async function summarizeStyleValidatorResult(
  reportPath: string,
  result: StyleValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<StyleValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus = resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeStyleReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Style validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

export async function summarizeArchitectureValidatorResult(
  reportPath: string,
  result: ArchitectureValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<ArchitectureValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus = resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeArchitectureReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Architecture validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

// =============================================================================
// FILE HELPERS
// =============================================================================

export async function readValidatorReport<T>(reportPath: string): Promise<T | null> {
  const exists = await fse.pathExists(reportPath);
  if (!exists) return null;

  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const payload = (raw as { result?: unknown }).result;
  if (!payload || typeof payload !== "object") return null;

  return payload as T;
}

export async function listValidatorReports(reportDir: string): Promise<string[]> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return [];

  const entries = await fse.readdir(reportDir);
  return entries.filter((name) => name.toLowerCase().endsWith(".json"));
}

export async function findLatestReport(
  reportDir: string,
  before: string[],
): Promise<string | null> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return null;

  const entries = (await fse.readdir(reportDir)).filter((name) =>
    name.toLowerCase().endsWith(".json"),
  );
  if (entries.length === 0) return null;

  const candidates = await Promise.all(
    entries.map(async (name) => {
      const fullPath = path.join(reportDir, name);
      const stat = await fse.stat(fullPath).catch(() => null);
      return { name, fullPath, mtimeMs: stat?.mtimeMs ?? 0, isNew: !before.includes(name) };
    }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates.find((c) => c.isNew) ?? candidates[0];
  return newest?.fullPath ?? null;
}

// =============================================================================
// RESULT HELPERS
// =============================================================================

export function relativeReportPath(
  projectName: string,
  runId: string,
  reportPath: string | null,
  paths?: PathsContext,
): string | null {
  if (!reportPath) return null;

  const base = runLogsDir(projectName, runId, paths);
  const relative = path.relative(base, reportPath);
  return relative.startsWith("..") ? reportPath : relative;
}

export function shouldBlockValidator(
  mode: ValidationResult["mode"],
  status: ValidatorStatus,
): boolean {
  if (mode !== "block") return false;
  return status === "fail" || status === "error";
}

export function buildBlockReason(
  validator: ValidationResult["validator"],
  summary: string | null,
): string {
  const label = VALIDATOR_LABELS[validator] ?? "Validator";
  if (summary && summary.trim().length > 0) {
    return `${label} validator blocked merge: ${summary}`;
  }
  return `${label} validator blocked merge (mode=block)`;
}

const VALIDATOR_LABELS: Record<ValidationResult["validator"], string> = {
  test: "Test",
  style: "Style",
  architecture: "Architecture",
  doctor: "Doctor",
};
