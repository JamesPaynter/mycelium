import path from "node:path";

import fse from "fs-extra";

import type { PathsContext } from "../core/paths.js";
import { runLogsDir } from "../core/paths.js";

import { readDiffSummary } from "./lib/io.js";
import { safeParseJson, truncate } from "./lib/normalize.js";

// =============================================================================
// TYPES
// =============================================================================

export type DoctorRunSample = {
  taskId: string;
  taskSlug: string;
  attempt: number;
  status?: "pass" | "fail";
  exitCode?: number;
  summary?: string;
  logPath: string;
  log: string;
  truncated: boolean;
};

export type DoctorCanaryResult =
  | { status: "expected_fail"; exitCode: number; output: string; envVar: string }
  | { status: "unexpected_pass"; exitCode: number; output: string; envVar: string }
  | { status: "skipped"; reason: string; envVar?: string };

export type DoctorValidatorTrigger =
  | "cadence"
  | "integration_doctor_failed"
  | "doctor_canary_failed"
  | "manual";

export type ValidationContext = {
  doctorCommand: string;
  diffSummary: string;
  doctorRuns: DoctorRunSample[];
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const DOCTOR_RUN_SAMPLE_LIMIT = 6;
const DOCTOR_LOG_CHAR_LIMIT = 2_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const INTEGRATION_OUTPUT_LIMIT = 3_000;
const DOCTOR_CANARY_LOG_LIMIT = 2_000;

// =============================================================================
// PUBLIC HELPERS
// =============================================================================

export async function buildValidationContext(params: {
  projectName: string;
  runId: string;
  repoPath: string;
  mainBranch: string;
  doctorCommand: string;
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
  paths?: PathsContext;
}): Promise<ValidationContext> {
  const runLogs = runLogsDir(params.projectName, params.runId, params.paths);

  const [diffSummary, doctorRuns] = await Promise.all([
    readDiffSummary(params.repoPath, params.mainBranch, DIFF_SUMMARY_LIMIT),
    readDoctorRuns(runLogs),
  ]);

  const integrationDoctorOutput = params.integrationDoctorOutput
    ? truncate(params.integrationDoctorOutput, INTEGRATION_OUTPUT_LIMIT).text
    : undefined;
  const doctorCanary = normalizeDoctorCanary(params.doctorCanary);

  return {
    doctorCommand: params.doctorCommand,
    diffSummary,
    doctorRuns,
    trigger: params.trigger,
    triggerNotes: params.triggerNotes,
    integrationDoctorOutput,
    doctorCanary,
  };
}

export function normalizeDoctorCanary(
  canary?: DoctorCanaryResult,
): DoctorCanaryResult | undefined {
  if (!canary) return undefined;
  if (canary.status === "skipped") return canary;

  return {
    ...canary,
    output: truncate(canary.output, DOCTOR_CANARY_LOG_LIMIT).text,
  };
}

// =============================================================================
// INTERNALS
// =============================================================================

async function readDoctorRuns(runLogs: string): Promise<DoctorRunSample[]> {
  const tasksDir = path.join(runLogs, "tasks");
  const exists = await fse.pathExists(tasksDir);
  if (!exists) return [];

  const taskDirs = (await fse.readdir(tasksDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );

  const allRuns: Array<DoctorRunSample & { mtimeMs: number }> = [];
  for (const dir of taskDirs) {
    const taskDir = path.join(tasksDir, dir.name);
    const { taskId, taskSlug } = parseTaskDirName(dir.name);
    const attemptStatuses = await readDoctorAttemptStatuses(path.join(taskDir, "events.jsonl"));

    const doctorLogs = (await fse.readdir(taskDir)).filter((file) =>
      /^doctor-\d+\.log$/i.test(file),
    );
    for (const logName of doctorLogs) {
      const attempt = parseAttempt(logName);
      if (attempt === null) continue;

      const fullPath = path.join(taskDir, logName);
      const stat = await fse.stat(fullPath).catch(() => null);
      if (!stat) continue;

      const { text, truncated } = await readFileTruncated(fullPath, DOCTOR_LOG_CHAR_LIMIT);
      const status = attemptStatuses.get(attempt);

      allRuns.push({
        taskId,
        taskSlug,
        attempt,
        status: status?.status,
        exitCode: status?.exitCode,
        summary: status?.summary,
        logPath: path.relative(runLogs, fullPath),
        log: text,
        truncated,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return allRuns
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, DOCTOR_RUN_SAMPLE_LIMIT)
    .map(({ mtimeMs: _mtimeMs, ...rest }) => rest);
}

async function readDoctorAttemptStatuses(
  eventsPath: string,
): Promise<Map<number, { status: "pass" | "fail"; exitCode?: number; summary?: string }>> {
  const statuses = new Map<
    number,
    { status: "pass" | "fail"; exitCode?: number; summary?: string }
  >();
  const exists = await fse.pathExists(eventsPath);
  if (!exists) return statuses;

  const lines = (await fse.readFile(eventsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = safeParseJson(line);
    if (!parsed) continue;

    const attempt = typeof parsed.attempt === "number" ? parsed.attempt : null;
    if (!attempt) continue;

    if (parsed.type === "doctor.pass") {
      statuses.set(attempt, { status: "pass" });
      continue;
    }

    if (parsed.type === "doctor.fail") {
      const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      const exitCode =
        payload && typeof (payload as { exit_code?: unknown }).exit_code === "number"
          ? (payload as { exit_code: number }).exit_code
          : undefined;
      const summary =
        payload && typeof (payload as { summary?: unknown }).summary === "string"
          ? (payload as { summary: string }).summary
          : undefined;
      statuses.set(attempt, { status: "fail", exitCode, summary });
    }
  }

  return statuses;
}

async function readFileTruncated(
  filePath: string,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const exists = await fse.pathExists(filePath);
  if (!exists) {
    return { text: "<log not found>", truncated: false };
  }

  const raw = await fse.readFile(filePath, "utf8");
  return truncate(raw.trim(), limit);
}

function parseAttempt(fileName: string): number | null {
  const match = fileName.match(/^doctor-(\d+)\.log$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseTaskDirName(name: string): { taskId: string; taskSlug: string } {
  const dashIndex = name.indexOf("-");
  if (dashIndex === -1) {
    return { taskId: name, taskSlug: name };
  }

  const taskId = name.slice(0, dashIndex);
  const taskSlug = name.slice(dashIndex + 1) || name;
  return { taskId, taskSlug };
}
