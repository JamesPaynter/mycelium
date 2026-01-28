import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonlLogger, eventWithTs, logOrchestratorEvent } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("logs orchestrator helpers with top-level fields", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-logger-"));
    const logPath = path.join(tmpDir, "events.jsonl");
    const logger = new JsonlLogger(logPath, { runId: "run-3" });

    logOrchestratorEvent(logger, "batch.start", {
      batch_id: 1,
      tasks: ["001"],
      taskId: "001",
    });
    logger.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const event = JSON.parse(lines[0]) as Record<string, unknown>;

    expect(event.type).toBe("batch.start");
    expect(event.run_id).toBe("run-3");
    expect(event.task_id).toBe("001");
    expect(event.batch_id).toBe(1);
    expect(event.tasks).toEqual(["001"]);
  });

  it("warns on write failures with formatted messages", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-logger-"));
    const logPath = path.join(tmpDir, "events.jsonl");
    const logger = new JsonlLogger(logPath, { runId: "run-4" });

    const writeError = new Error("disk full");
    vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw writeError;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.log({ type: "task.start" });
    logger.close();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(message).toContain("Warning:");
    expect(message).toContain("write log event");
    expect(message).toContain(logPath);
    expect(message).toContain("disk full");
  });

  it("includes stack details when debug is enabled", () => {
    const originalArgv = [...process.argv];
    process.argv = [...process.argv, "--debug"];

    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-logger-"));
      const logPath = path.join(tmpDir, "events.jsonl");
      const logger = new JsonlLogger(logPath, { runId: "run-5" });

      const writeError = new Error("disk full");
      vi.spyOn(fs, "writeSync").mockImplementation(() => {
        throw writeError;
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      logger.log({ type: "task.start" });
      logger.close();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0];
      expect(message).toContain("disk full");
      if (writeError.stack) {
        expect(message).toContain(writeError.stack);
      }
    } finally {
      process.argv = originalArgv;
    }
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
