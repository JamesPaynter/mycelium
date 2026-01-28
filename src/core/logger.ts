import fs from "node:fs";
import path from "node:path";

import fse from "fs-extra";

import { formatErrorLines, formatErrorMessage } from "./error-format.js";
import { isoNow } from "./utils.js";

// =============================================================================
// TYPES
// =============================================================================

export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type LogEvent = JsonObject & {
  ts: string;
  type: string;
  run_id: string;
  task_id?: string;
  payload?: JsonObject;
};

export type LogEventInput = JsonObject & {
  type: string;
  runId?: string;
  taskId?: string;
  payload?: JsonObject;
  ts?: string | Date;
};

type EventDefaults = {
  runId?: string;
  taskId?: string;
};

type LogFailureAction = "write" | "close";

// =============================================================================
// LOGGER
// =============================================================================

export class JsonlLogger {
  private readonly fileDescriptor: number;
  private readonly isDebugEnabled: boolean;
  private closed = false;

  constructor(
    public readonly filePath: string,
    private readonly defaults: EventDefaults = {},
  ) {
    fse.ensureDirSync(path.dirname(filePath));
    this.fileDescriptor = fs.openSync(filePath, "a");
    this.isDebugEnabled = resolveLoggerDebugEnabled();
  }

  log(event: LogEventInput): void {
    const normalized = eventWithTs(event, this.defaults);
    this.append(normalized);
  }

  close(): void {
    if (this.closed) return;
    try {
      fs.fsyncSync(this.fileDescriptor);
      fs.closeSync(this.fileDescriptor);
    } catch (err) {
      console.warn(formatLogFailureWarning("close", this.filePath, err, this.isDebugEnabled));
    } finally {
      this.closed = true;
    }
  }

  private append(event: LogEvent): void {
    if (this.closed) return;
    try {
      fs.writeSync(this.fileDescriptor, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(this.fileDescriptor);
    } catch (err) {
      console.warn(formatLogFailureWarning("write", this.filePath, err, this.isDebugEnabled));
    }
  }
}

// =============================================================================
// EVENT HELPERS
// =============================================================================

export function eventWithTs(event: LogEventInput, defaults: EventDefaults = {}): LogEvent {
  const { runId: providedRunId, taskId, payload, ts, type, ...rest } = event;

  const runId = providedRunId ?? defaults.runId;
  if (!runId) {
    throw new Error("run_id is required for log events");
  }

  const normalizedTs =
    typeof ts === "string" ? ts : ts instanceof Date ? ts.toISOString() : isoNow();

  const resolvedTaskId = taskId ?? defaults.taskId;

  const result: LogEvent = {
    ...rest,
    ts: normalizedTs,
    type,
    run_id: runId,
  };

  if (resolvedTaskId) {
    result.task_id = resolvedTaskId;
  }
  if (payload && Object.keys(payload).length > 0) {
    result.payload = payload;
  }

  return result;
}

export function logOrchestratorEvent(
  logger: JsonlLogger,
  type: string,
  fields: JsonObject & { taskId?: string; ts?: string | Date } = {},
): void {
  const { taskId, ts, ...rest } = fields;
  const event: LogEventInput = { type, ...rest };

  if (taskId !== undefined) {
    event.taskId = taskId;
  }
  if (ts !== undefined) {
    event.ts = ts;
  }

  logger.log(event);
}

export function logRunResume(
  logger: JsonlLogger,
  details: { status: string; reason?: string; resetTasks?: number; runningTasks?: number },
): void {
  const payload: JsonObject = { status: details.status };
  if (details.reason) payload.reason = details.reason;
  if (details.resetTasks !== undefined) payload.reset_tasks = details.resetTasks;
  if (details.runningTasks !== undefined) payload.running_tasks = details.runningTasks;

  logOrchestratorEvent(logger, "run.resume", payload);
}

export function logTaskReset(logger: JsonlLogger, taskId: string, reason: string): void {
  logOrchestratorEvent(logger, "task.reset", { taskId, reason });
}

export function logJsonLineOrRaw(
  logger: JsonlLogger,
  line: string,
  stream: "stdout" | "stderr",
  fallbackType = "task.log",
): void {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in (parsed as Record<string, unknown>) &&
      typeof (parsed as Record<string, unknown>).type === "string"
    ) {
      const { type, ts, ...rest } = parsed as Record<string, unknown>;
      const payload = { ...rest, stream } as JsonObject;
      const event: LogEventInput = { type: String(type), payload };
      if (typeof ts === "string") {
        event.ts = ts;
      }
      logger.log(event);
      return;
    }
  } catch {
    // fall through to raw logging
  }

  logger.log({ type: fallbackType, payload: { stream, raw: line } });
}

// =============================================================================
// INTERNALS
// =============================================================================

function formatLogFailureWarning(
  action: LogFailureAction,
  filePath: string,
  error: unknown,
  isDebugEnabled: boolean,
): string {
  const summary = formatErrorMessage(error);
  const actionLabel =
    action === "write" ? `write log event to ${filePath}` : `close log file ${filePath}`;
  const message = `Warning: failed to ${actionLabel}: ${summary}`;

  if (!isDebugEnabled) {
    return message;
  }

  const stack = resolveDebugStack(error);
  if (!stack) {
    return message;
  }

  return `${message}\n${stack}`;
}

function resolveDebugStack(error: unknown): string | undefined {
  const lines = formatErrorLines(error, { mode: "debug" });
  const stackLine = lines.find((line) => line.kind === "stack");
  return stackLine?.text;
}

function resolveLoggerDebugEnabled(): boolean {
  const argvFlag = resolveDebugFlagFromArgv(process.argv);
  return argvFlag ?? false;
}

function resolveDebugFlagFromArgv(argv: string[]): boolean | undefined {
  let debugFlag: boolean | undefined;

  for (const arg of argv) {
    if (arg === "--") {
      break;
    }

    if (arg === "--debug") {
      debugFlag = true;
    }

    if (arg === "--no-debug") {
      debugFlag = false;
    }
  }

  return debugFlag;
}
