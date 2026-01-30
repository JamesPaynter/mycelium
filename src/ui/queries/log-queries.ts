import fs from "node:fs/promises";
import path from "node:path";

import { findTaskLogDir, readJsonlFromCursor } from "../../core/log-query.js";
import { resolveRunLogsDir, type Paths } from "../../core/paths.js";
import { readDoctorLogSnippet } from "../../core/run-logs.js";

import {
  findValidatorReportPath,
  normalizeLogPath,
  parseCursorParam,
  parseOptionalNonNegativeInteger,
  parseOptionalPositiveInteger,
  parseOptionalString,
  readJsonFileWithLimit,
} from "./log-query-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export type LogQueryError = {
  code: "bad_request" | "not_found" | "report_too_large";
  message: string;
};

export type LogQueryResult<T> = { ok: true; result: T } | { ok: false; error: LogQueryError };

export type LogTailResult = {
  file: string;
  cursor: number;
  nextCursor: number;
  truncated: boolean;
  lines: string[];
};

export type DoctorSnippetResult = {
  file: string;
  content: string;
};

export type JsonReportResult = {
  file: string;
  report: unknown;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_DOCTOR_SNIPPET_LIMIT = 6000;
const MAX_DOCTOR_SNIPPET_LIMIT = 20000;
const MAX_JSON_REPORT_BYTES = 1024 * 1024;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function queryOrchestratorEvents(params: {
  projectName: string;
  runId: string;
  cursor: string | null;
  maxBytes: string | null;
  typeGlob?: string | null;
  taskId?: string | null;
  paths?: Paths;
}): Promise<LogQueryResult<LogTailResult>> {
  const cursorResult = parseCursorParam(params.cursor);
  if (!cursorResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid cursor value." } };
  }

  const maxBytesResult = parseOptionalNonNegativeInteger(params.maxBytes);
  if (!maxBytesResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid maxBytes value." } };
  }

  const typeGlob = parseOptionalString(params.typeGlob ?? null);
  const taskId = parseOptionalString(params.taskId ?? null);

  const resolved = resolveRunLogsDir(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return { ok: false, error: { code: "not_found", message: "Run logs not found." } };
  }

  const logPath = path.join(resolved.dir, "orchestrator.jsonl");
  const cursor =
    cursorResult.value === "tail" ? await resolveTailCursor(logPath) : cursorResult.value;

  const readOptions = maxBytesResult.value === null ? {} : { maxBytes: maxBytesResult.value };
  const result = await readJsonlFromCursor(logPath, cursor, { taskId, typeGlob }, readOptions);

  return {
    ok: true,
    result: {
      file: normalizeLogPath(resolved.dir, logPath),
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      truncated: result.truncated,
      lines: result.lines,
    },
  };
}

export async function queryTaskEvents(params: {
  projectName: string;
  runId: string;
  taskId: string;
  cursor: string | null;
  maxBytes: string | null;
  typeGlob?: string | null;
  paths?: Paths;
}): Promise<LogQueryResult<LogTailResult>> {
  const cursorResult = parseCursorParam(params.cursor);
  if (!cursorResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid cursor value." } };
  }

  const maxBytesResult = parseOptionalNonNegativeInteger(params.maxBytes);
  if (!maxBytesResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid maxBytes value." } };
  }

  const typeGlob = parseOptionalString(params.typeGlob ?? null);

  const resolved = resolveRunLogsDir(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return { ok: false, error: { code: "not_found", message: "Run logs not found." } };
  }

  const taskLogDir = findTaskLogDir(resolved.dir, params.taskId);
  if (!taskLogDir) {
    return { ok: false, error: { code: "not_found", message: "Task logs not found." } };
  }

  const logPath = path.join(taskLogDir, "events.jsonl");
  const cursor =
    cursorResult.value === "tail" ? await resolveTailCursor(logPath) : cursorResult.value;

  const readOptions = maxBytesResult.value === null ? {} : { maxBytes: maxBytesResult.value };
  const result = await readJsonlFromCursor(logPath, cursor, { typeGlob }, readOptions);

  return {
    ok: true,
    result: {
      file: normalizeLogPath(resolved.dir, logPath),
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      truncated: result.truncated,
      lines: result.lines,
    },
  };
}

export async function queryDoctorSnippet(params: {
  projectName: string;
  runId: string;
  taskId: string;
  attempt: string | null;
  limit: string | null;
  paths?: Paths;
}): Promise<LogQueryResult<DoctorSnippetResult>> {
  const attemptResult = parseOptionalPositiveInteger(params.attempt);
  if (!attemptResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid attempt value." } };
  }

  const limitResult = parseOptionalPositiveInteger(params.limit);
  if (!limitResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid limit value." } };
  }

  const requestedLimit = limitResult.value ?? DEFAULT_DOCTOR_SNIPPET_LIMIT;
  if (requestedLimit > MAX_DOCTOR_SNIPPET_LIMIT) {
    return {
      ok: false,
      error: {
        code: "bad_request",
        message: `Limit exceeds maximum of ${MAX_DOCTOR_SNIPPET_LIMIT} characters.`,
      },
    };
  }

  const resolved = resolveRunLogsDir(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return { ok: false, error: { code: "not_found", message: "Run logs not found." } };
  }

  const snippet = readDoctorLogSnippet(
    resolved.dir,
    params.taskId,
    attemptResult.value,
    requestedLimit,
  );
  if (!snippet) {
    return { ok: false, error: { code: "not_found", message: "Doctor logs not found." } };
  }

  return {
    ok: true,
    result: {
      file: normalizeLogPath(resolved.dir, snippet.path),
      content: snippet.content,
    },
  };
}

export async function queryComplianceReport(params: {
  projectName: string;
  runId: string;
  taskId: string;
  paths?: Paths;
}): Promise<LogQueryResult<JsonReportResult>> {
  const resolved = resolveRunLogsDir(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return { ok: false, error: { code: "not_found", message: "Run logs not found." } };
  }

  const taskLogDir = findTaskLogDir(resolved.dir, params.taskId);
  if (!taskLogDir) {
    return {
      ok: false,
      error: { code: "not_found", message: "Compliance report not found." },
    };
  }

  const compliancePath = path.join(taskLogDir, "compliance.json");
  const report = await readJsonFileWithLimit(compliancePath, MAX_JSON_REPORT_BYTES);
  if (!report.ok) {
    if (report.reason === "too_large") {
      return {
        ok: false,
        error: { code: "report_too_large", message: "Compliance report exceeds size limit." },
      };
    }
    return {
      ok: false,
      error: { code: "not_found", message: "Compliance report not found." },
    };
  }

  return {
    ok: true,
    result: {
      file: normalizeLogPath(resolved.dir, compliancePath),
      report: report.value,
    },
  };
}

export async function queryValidatorReport(params: {
  projectName: string;
  runId: string;
  validator: string;
  taskId: string;
  paths?: Paths;
}): Promise<LogQueryResult<JsonReportResult>> {
  const resolved = resolveRunLogsDir(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return { ok: false, error: { code: "not_found", message: "Run logs not found." } };
  }

  const reportPath = await findValidatorReportPath(resolved.dir, params.validator, params.taskId);
  if (!reportPath) {
    return {
      ok: false,
      error: { code: "not_found", message: "Validator report not found." },
    };
  }

  const report = await readJsonFileWithLimit(reportPath, MAX_JSON_REPORT_BYTES);
  if (!report.ok) {
    if (report.reason === "too_large") {
      return {
        ok: false,
        error: { code: "report_too_large", message: "Validator report exceeds size limit." },
      };
    }
    return {
      ok: false,
      error: { code: "not_found", message: "Validator report not found." },
    };
  }

  return {
    ok: true,
    result: {
      file: normalizeLogPath(resolved.dir, reportPath),
      report: report.value,
    },
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function resolveTailCursor(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (err) {
    if (isMissingFile(err)) return 0;
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}
