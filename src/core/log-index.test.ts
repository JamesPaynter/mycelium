import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LogIndex, logIndexPath } from "./log-index.js";

function writeJsonl(filePath: string, lines: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  fs.writeFileSync(filePath, `${content}\n`, "utf8");
}

describe("LogIndex", () => {
  it("ingests run logs and supports filtered queries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-index-"));
    const runLogsDir = path.join(tmpDir, "run-123");

    writeJsonl(path.join(runLogsDir, "orchestrator.jsonl"), [
      { ts: "2024-01-01T00:00:00Z", type: "run.start", payload: { note: "hello" } },
      { ts: "2024-01-01T00:00:05Z", type: "doctor.pass", task_id: "002" },
    ]);

    writeJsonl(path.join(runLogsDir, "tasks", "001-alpha", "events.jsonl"), [
      { ts: "2024-01-01T00:00:01Z", type: "task.log", task_id: "001", payload: { text: "hello" } },
      {
        ts: "2024-01-01T00:00:02Z",
        type: "doctor.fail",
        task_id: "001",
        payload: { text: "needle in haystack" },
      },
    ]);

    writeJsonl(path.join(runLogsDir, "validators", "test-validator.jsonl"), [
      { ts: "2024-01-01T00:00:03Z", type: "validator.note", payload: { task_id: "001", status: "ok" } },
    ]);

    const dbPath = logIndexPath(runLogsDir);
    const index = LogIndex.open("123", runLogsDir, dbPath);

    const firstInserted = index.ingestRunLogs(runLogsDir);
    expect(firstInserted).toBe(5);

    const secondInserted = index.ingestRunLogs(runLogsDir);
    expect(secondInserted).toBe(0);

    const allEvents = index.queryEvents();
    expect(allEvents.map((e) => e.type)).toEqual([
      "run.start",
      "task.log",
      "doctor.fail",
      "validator.note",
      "doctor.pass",
    ]);

    const taskEvents = index.queryEvents({ taskId: "001" });
    expect(taskEvents).toHaveLength(2);
    expect(new Set(taskEvents.map((e) => e.type))).toEqual(new Set(["task.log", "doctor.fail"]));
    expect(taskEvents[0].source.endsWith("events.jsonl")).toBe(true);

    const doctorEvents = index.queryEvents({ typeGlob: "doctor.*" });
    expect(doctorEvents.map((e) => e.type)).toEqual(["doctor.fail", "doctor.pass"]);

    const searchEvents = index.queryEvents({ search: "needle" });
    expect(searchEvents).toHaveLength(1);
    expect(searchEvents[0].raw).toContain("needle in haystack");
    expect(searchEvents[0].lineNumber).toBe(2);

    index.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
