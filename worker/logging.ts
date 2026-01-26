import fs from "node:fs";
import path from "node:path";

// =============================================================================
// TYPES
// =============================================================================

export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type WorkerLogEventInput = {
  type: string;
  attempt?: number;
  taskId?: string;
  taskSlug?: string;
  payload?: JsonObject;
  ts?: string | Date;
};

export type WorkerLogEvent = {
  ts: string;
  type: string;
  attempt?: number;
  task_id?: string;
  task_slug?: string;
  payload?: JsonObject;
};

export type WorkerLogger = {
  log: (event: WorkerLogEventInput) => void;
};

// =============================================================================
// LOGGING
// =============================================================================

export function createStdoutLogger(
  defaults: { taskId?: string; taskSlug?: string } = {},
): WorkerLogger {
  return {
    log(event: WorkerLogEventInput) {
      const normalized = normalizeEvent(event, defaults);
      writeEvent(normalized);
    },
  };
}

function normalizeEvent(
  event: WorkerLogEventInput,
  defaults: { taskId?: string; taskSlug?: string },
): WorkerLogEvent {
  const ts =
    typeof event.ts === "string"
      ? event.ts
      : event.ts instanceof Date
        ? event.ts.toISOString()
        : isoNow();

  const payload =
    event.payload && Object.keys(event.payload).length > 0 ? event.payload : undefined;

  const normalized: WorkerLogEvent = {
    ts,
    type: event.type,
  };

  if (event.attempt !== undefined) {
    normalized.attempt = event.attempt;
  }
  const taskId = event.taskId ?? defaults.taskId;
  if (taskId) {
    normalized.task_id = taskId;
  }
  const taskSlug = event.taskSlug ?? defaults.taskSlug;
  if (taskSlug) {
    normalized.task_slug = taskSlug;
  }
  if (payload) {
    normalized.payload = payload;
  }

  return normalized;
}

function writeEvent(event: WorkerLogEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// =============================================================================
// HELPERS
// =============================================================================

export function isoNow(): string {
  return new Date().toISOString();
}

export function writeRunLog(runLogsDir: string, fileName: string, content: string): void {
  try {
    fs.mkdirSync(runLogsDir, { recursive: true });
    fs.writeFileSync(path.join(runLogsDir, fileName), content, "utf8");
  } catch {
    // Best-effort persistence; worker should not crash on log write failures.
  }
}

export function safeAttemptName(attempt: number): string {
  return String(attempt).padStart(3, "0");
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}
