import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  filterJsonlLines,
  searchLogs,
  taskEventsLogPathForId,
  findTaskLogDir,
} from "./log-query.js";

describe("filterJsonlLines", () => {
  it("filters by task id and type glob", () => {
    const lines = [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", type: "task.start", task_id: "001" }),
      JSON.stringify({ ts: "2024-01-01T00:00:01Z", type: "doctor.fail", task_id: "001" }),
      JSON.stringify({ ts: "2024-01-01T00:00:02Z", type: "doctor.pass", task_id: "002" }),
    ];

    const filtered = filterJsonlLines(lines, { taskId: "001", typeGlob: "doctor.*" });
    expect(filtered).toHaveLength(1);

    const event = JSON.parse(filtered[0]) as { type: string; task_id?: string };
    expect(event.type).toBe("doctor.fail");
    expect(event.task_id).toBe("001");
  });
});

describe("searchLogs", () => {
  it("searches across run logs and scopes to task when requested", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-query-"));
    const runDir = path.join(tmpDir, "run-123");
    const taskDir = path.join(runDir, "tasks", "001-example");
    fs.mkdirSync(taskDir, { recursive: true });

    fs.writeFileSync(
      path.join(runDir, "orchestrator.jsonl"),
      ['{"type":"run.start","message":"hello"}', '{"type":"note","message":"needle found"}'].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(taskDir, "events.jsonl"),
      ['{"type":"task.log","task_id":"001","payload":{"text":"needle in task"}}'].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(taskDir, "doctor-001.log"), "doctor output\nneedle doctor line\n", "utf8");

    expect(findTaskLogDir(runDir, "001")).toBe(taskDir);
    expect(taskEventsLogPathForId(runDir, "001")).toBe(path.join(taskDir, "events.jsonl"));
    expect(taskEventsLogPathForId(runDir, "999")).toBeNull();

    const allMatches = searchLogs(runDir, "needle");
    expect(allMatches.map((m) => path.basename(m.filePath)).sort()).toEqual([
      "doctor-001.log",
      "events.jsonl",
      "orchestrator.jsonl",
    ]);

    const taskMatches = searchLogs(runDir, "needle", { taskId: "001" });
    expect(taskMatches.map((m) => path.basename(m.filePath)).sort()).toEqual([
      "doctor-001.log",
      "events.jsonl",
    ]);
  });
});
