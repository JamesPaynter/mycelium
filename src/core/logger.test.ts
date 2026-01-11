import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlLogger, eventWithTs } from "./logger.js";

describe("JsonlLogger", () => {
  it("writes events with run and task metadata", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-logger-"));
    const logPath = path.join(tmpDir, "nested", "events.jsonl");
    const logger = new JsonlLogger(logPath, { runId: "run-1", taskId: "task-9" });

    logger.log({ type: "task.start", payload: { message: "hello" } });
    logger.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(event.type).toBe("task.start");
    expect(event.run_id).toBe("run-1");
    expect(event.task_id).toBe("task-9");
    expect(event.payload).toEqual({ message: "hello" });
    expect(new Date(String(event.ts)).toString()).not.toBe("Invalid Date");
  });

  it("appends events without clobbering previous lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-logger-"));
    const logPath = path.join(tmpDir, "events.jsonl");
    const logger = new JsonlLogger(logPath, { runId: "run-2" });

    logger.log({ type: "first", payload: { order: 1 } });
    logger.log({ type: "second", payload: { order: 2 } });
    logger.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.map((e) => e.type)).toEqual(["first", "second"]);
    expect(events.map((e) => e.payload)).toEqual([{ order: 1 }, { order: 2 }]);
  });
});

describe("eventWithTs", () => {
  it("merges defaults and payload", () => {
    const event = eventWithTs(
      { type: "sample", payload: { key: "value" }, taskId: "t-1" },
      { runId: "run-x" },
    );

    expect(event.run_id).toBe("run-x");
    expect(event.task_id).toBe("t-1");
    expect(event.type).toBe("sample");
    expect(event.payload).toEqual({ key: "value" });
    expect(new Date(event.ts).toString()).not.toBe("Invalid Date");
  });

  it("throws when runId is missing", () => {
    expect(() => eventWithTs({ type: "missing-run" })).toThrow(/run_id is required/i);
  });
});
