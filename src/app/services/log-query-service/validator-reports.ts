import fs from "node:fs";
import path from "node:path";

import type { DoctorValidationReport } from "../../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../../validators/style-validator.js";
import type { TestValidationReport } from "../../../validators/test-validator.js";
import {
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "../../orchestrator/validation/summaries.js";

import type { ValidatorSummaryRow } from "./types.js";
import { relativeToRun } from "./utils.js";

// =============================================================================
// VALIDATOR REPORT LOOKUP
// =============================================================================

export async function findTestValidatorReport(
  runLogsDir: string,
  taskId: string,
): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "test-validator");
  const reportPath = await pickLatestJson(dir, (name) => name.startsWith(`${taskId}-`));
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<TestValidationReport>(reportPath);
  if (!report) return null;

  const status = report.pass ? "pass" : "fail";
  return {
    validator: "test",
    status,
    summary: summarizeTestReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

export async function findStyleValidatorReport(
  runLogsDir: string,
  taskId: string,
): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "style-validator");
  const reportPath = await pickLatestJson(dir, (name) => name.startsWith(`${taskId}-`));
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<StyleValidationReport>(reportPath);
  if (!report) return null;

  const status = report.pass ? "pass" : "fail";
  return {
    validator: "style",
    status,
    summary: summarizeStyleReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

export async function findDoctorValidatorReport(
  runLogsDir: string,
): Promise<ValidatorSummaryRow | null> {
  const dir = path.join(runLogsDir, "validators", "doctor-validator");
  const reportPath = await pickLatestJson(dir);
  if (!reportPath) return null;

  const report = readValidatorResultFromFile<DoctorValidationReport>(reportPath);
  if (!report) return null;

  const status = report.effective ? "pass" : "fail";
  return {
    validator: "doctor",
    status,
    summary: summarizeDoctorReport(report),
    reportPath: relativeToRun(runLogsDir, reportPath),
  };
}

async function pickLatestJson(
  dir: string,
  matcher: (name: string) => boolean = () => true,
): Promise<string | null> {
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(".json") && matcher(file));
  if (files.length === 0) return null;

  const withTime = files
    .map((file) => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return withTime[0]?.fullPath ?? null;
}

function readValidatorResultFromFile<T>(filePath: string): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const payload = (raw as { result?: unknown }).result;
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return payload as T;
  } catch {
    return null;
  }
}
