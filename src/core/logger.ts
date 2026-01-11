import fs from "node:fs";
import path from "node:path";

import fse from "fs-extra";

import { isoNow } from "./utils.js";

export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type LogEvent = {
  ts: string;
  type: string;
  run_id: string;
  task_id?: string;
  payload?: JsonObject;
};

export type LogEventInput = {
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

export class JsonlLogger {
  private fileDescriptor: number;
  private closed = false;

  constructor(public readonly filePath: string, private readonly defaults: EventDefaults = {}) {
    fse.ensureDirSync(path.dirname(filePath));
    this.fileDescriptor = fs.openSync(filePath, "a");
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
      console.error(`Failed to close log file ${this.filePath}:`, err);
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
      console.error(`Failed to write log event to ${this.filePath}:`, err);
    }
  }
}

export function eventWithTs(event: LogEventInput, defaults: EventDefaults = {}): LogEvent {
  const runId = event.runId ?? defaults.runId;
  if (!runId) {
    throw new Error("run_id is required for log events");
  }

  const ts =
    typeof event.ts === "string"
      ? event.ts
      : event.ts instanceof Date
        ? event.ts.toISOString()
        : isoNow();

  const payload = event.payload;
  const taskId = event.taskId ?? defaults.taskId;

  const result: LogEvent = {
    ts,
    type: event.type,
    run_id: runId,
  };

  if (taskId) {
    result.task_id = taskId;
  }
  if (payload && Object.keys(payload).length > 0) {
    result.payload = payload;
  }

  return result;
}
