import fs from "node:fs";
import path from "node:path";

import { LogIndex, logIndexPath, type LogIndexQuery } from "./log-index.js";

// =============================================================================
// TYPES
// =============================================================================

export type RunLogEvent = {
  ts: string;
  type: string;
  taskId: string | null;
  attempt: number | null;
  payload: Record<string, unknown> | null;
  raw: string;
  source: string;
  lineNumber: number;
};

export type RunEventFilter = {
  taskId?: string;
  typeGlob?: string;
  search?: string;
};

// =============================================================================
// EVENT LOADING
// =============================================================================

export function loadRunEvents(
  runId: string,
  runLogsDir: string,
  opts: { useIndex?: boolean } & RunEventFilter = {},
): RunLogEvent[] {
  const preferIndex = opts.useIndex ?? false;
  if (preferIndex) {
    const fromIndex = loadEventsFromIndex(runId, runLogsDir, opts);
    if (fromIndex) {
      return fromIndex;
    }
  }

  return loadEventsFromFiles(runLogsDir, opts);
}

function loadEventsFromIndex(
  runId: string,
  runLogsDir: string,
  filter: RunEventFilter,
): RunLogEvent[] | null {
  const dbPath = logIndexPath(runLogsDir);
  let index: LogIndex | null = null;

  try {
    const query: LogIndexQuery = {};
    if (filter.taskId) query.taskId = filter.taskId;
    if (filter.typeGlob) query.typeGlob = filter.typeGlob;
    if (filter.search) query.search = filter.search;

    index = LogIndex.open(runId, runLogsDir, dbPath);
    index.ingestRunLogs(runLogsDir);
    return index.queryEvents(query).map((row, idx) => ({
      ts: row.ts,
      type: row.type,
      taskId: row.taskId ?? null,
      attempt: extractAttempt(row),
      payload: row.payload ?? null,
      raw: row.raw,
      source: row.source,
      lineNumber: row.lineNumber ?? idx + 1,
    }));
  } catch {
    return null;
  } finally {
    if (index) index.close();
  }
}

function loadEventsFromFiles(runLogsDir: string, filter: RunEventFilter): RunLogEvent[] {
  const files = listJsonlFiles(runLogsDir);
  const events: RunLogEvent[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;

      const parsed = parseEventLine(line, file, i + 1);
      if (!parsed) continue;
      if (!matchesFilter(parsed, filter)) continue;

      events.push(parsed);
    }
  }

  return events.sort(compareEvents);
}

function parseEventLine(raw: string, source: string, lineNumber: number): RunLogEvent | null {
  const parsed = safeParseJson(raw);
  if (!parsed) return null;

  const ts = typeof parsed.ts === "string" ? parsed.ts : null;
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!ts || !type) return null;

  return {
    ts,
    type,
    taskId: extractTaskId(parsed),
    attempt: extractAttempt(parsed),
    payload: extractPayload(parsed),
    raw,
    source,
    lineNumber,
  };
}

function matchesFilter(event: RunLogEvent, filter: RunEventFilter): boolean {
  if (filter.taskId && event.taskId !== filter.taskId) return false;
  if (filter.typeGlob && !matchesGlob(event.type, filter.typeGlob)) return false;
  if (filter.search && !event.raw.includes(filter.search)) return false;
  return true;
}

function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function matchesGlob(value: string, glob: string): boolean {
  const escaped = glob.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
  return regex.test(value);
}

function compareEvents(a: RunLogEvent, b: RunLogEvent): number {
  if (a.ts !== b.ts) {
    return a.ts < b.ts ? -1 : 1;
  }
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.lineNumber - b.lineNumber;
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractTaskId(event: Record<string, unknown>): string | null {
  if (typeof event.task_id === "string") return event.task_id;
  if (typeof (event as { taskId?: unknown }).taskId === "string") {
    return (event as { taskId: string }).taskId;
  }
  if (typeof (event.payload as { task_id?: unknown })?.task_id === "string") {
    return String((event.payload as { task_id: unknown }).task_id);
  }
  return null;
}

function extractAttempt(event: Record<string, unknown>): number | null {
  const root = (event as { attempt?: unknown }).attempt;
  if (typeof root === "number" && Number.isFinite(root)) return root;

  const inPayload = (event as { payload?: { attempt?: unknown } }).payload?.attempt;
  if (typeof inPayload === "number" && Number.isFinite(inPayload)) return inPayload;

  return null;
}

function extractPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

// =============================================================================
// TASK LOG HELPERS
// =============================================================================

export function listTaskEventLogs(runLogsDir: string): string[] {
  const tasksDir = path.join(runLogsDir, "tasks");
  if (!fs.existsSync(tasksDir)) return [];

  const files: string[] = [];
  const taskEntries = fs.readdirSync(tasksDir, { withFileTypes: true });
  for (const entry of taskEntries) {
    if (!entry.isDirectory()) continue;
    const eventsPath = path.join(tasksDir, entry.name, "events.jsonl");
    if (fs.existsSync(eventsPath)) {
      files.push(eventsPath);
    }
  }

  return files.sort();
}

export function readDoctorLogSnippet(
  runLogsDir: string,
  taskId: string,
  attempt?: number | null,
  limit = 600,
): { path: string; content: string } | null {
  const taskDir = findTaskLogDir(runLogsDir, taskId);
  if (!taskDir) return null;

  const candidates = fs
    .readdirSync(taskDir)
    .filter((name) => name.startsWith("doctor-") && name.endsWith(".log"))
    .map((name) => ({ name, attempt: parseAttempt(name) }))
    .filter((entry) => entry.attempt !== null)
    .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0));

  if (candidates.length === 0) return null;

  const selected =
    attempt !== undefined && attempt !== null
      ? (candidates.find((c) => c.attempt === attempt) ?? candidates[0])
      : candidates[0];

  const fullPath = path.join(taskDir, selected.name);
  const raw = fs.readFileSync(fullPath, "utf8").trim();
  const truncated = raw.length > limit ? `${raw.slice(0, limit)}\n...[truncated]` : raw;

  return { path: fullPath, content: truncated || "<empty doctor log>" };
}

export function findTaskLogDir(runLogsDir: string, taskId: string): string | null {
  const tasksDir = path.join(runLogsDir, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return null;
  }

  const match = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith(`${taskId}-`));

  return match ? path.join(tasksDir, match.name) : null;
}

function parseAttempt(fileName: string): number | null {
  const match = fileName.match(/doctor-(\d+)\.log$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}
