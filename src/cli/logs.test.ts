import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildFailureGroups, buildTimeline } from "./logs.js";
import type { RunLogEvent } from "../core/run-logs.js";
import type { RunState } from "../core/state.js";

function makeEvent(base: Partial<RunLogEvent> & { ts: string; type: string }): RunLogEvent {
  return {
    ts: base.ts,
    type: base.type,
    taskId: base.taskId ?? null,
    attempt: base.attempt ?? null,
    payload: (base.payload as Record<string, unknown>) ?? null,
    raw: base.raw ?? "",
    source: base.source ?? "orchestrator.jsonl",
    lineNumber: base.lineNumber ?? 1,
  };
}

describe("buildTimeline", () => {
  it("includes run, batch, and task events with durations when state is provided", () => {
    const events: RunLogEvent[] = [
      makeEvent({ ts: "2024-01-01T00:00:00Z", type: "run.start" }),
      makeEvent({
        ts: "2024-01-01T00:01:00Z",
        type: "batch.start",
        payload: { batch_id: 1, tasks: ["001"] },
      }),
      makeEvent({
        ts: "2024-01-01T00:09:00Z",
        type: "task.failed",
        taskId: "001",
        payload: { attempts: 2, message: "doctor failed" },
      }),
      makeEvent({
        ts: "2024-01-01T00:10:00Z",
        type: "batch.complete",
        payload: { batch_id: 1 },
      }),
      makeEvent({
        ts: "2024-01-01T00:10:00Z",
        type: "run.complete",
        payload: { status: "failed" },
      }),
    ];

    const state: RunState = {
      run_id: "123",
      project: "proj",
      repo_path: "/tmp/repo",
      main_branch: "main",
      started_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:10:00Z",
      status: "failed",
      batches: [
        {
          batch_id: 1,
          status: "failed",
          tasks: ["001"],
          started_at: "2024-01-01T00:01:00Z",
          completed_at: "2024-01-01T00:10:00Z",
        },
      ],
      tasks: {
        "001": {
          status: "failed",
          attempts: 2,
          started_at: "2024-01-01T00:01:00Z",
          completed_at: "2024-01-01T00:09:00Z",
          checkpoint_commits: [],
          validator_results: [],
          tokens_used: 0,
          estimated_cost: 0,
          usage_by_attempt: [],
        },
      },
      tokens_used: 0,
      estimated_cost: 0,
    };

    const timeline = buildTimeline(events, state);
    expect(timeline.entries.map((e) => e.label)).toEqual([
      "Run started",
      "Batch 1 started",
      "Task 001 failed",
      "Batch 1 complete",
      "Run completed (failed)",
    ]);
    expect(timeline.runDurationMs).toBe(10 * 60 * 1000);
    expect(timeline.taskCounts?.failed).toBe(1);
    expect(timeline.taskCounts?.complete).toBe(0);
  });
});

describe("buildFailureGroups", () => {
  it("groups failures and surfaces doctor snippets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-failures-"));
    const runLogsDir = path.join(tmpDir, "run-123");
    const taskDir = path.join(runLogsDir, "tasks", "001-alpha");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "doctor-001.log"),
      "doctor stack trace\nline two\n",
      "utf8",
    );

    const events: RunLogEvent[] = [
      makeEvent({
        ts: "2024-01-01T00:00:02Z",
        type: "doctor.fail",
        taskId: "001",
        attempt: 1,
        payload: { summary: "doctor failed", exit_code: 1 },
        source: path.join(taskDir, "events.jsonl"),
      }),
      makeEvent({
        ts: "2024-01-01T00:00:03Z",
        type: "task.failed",
        taskId: "001",
        payload: { message: "worker error" },
        source: "orchestrator.jsonl",
      }),
    ];

    const groups = buildFailureGroups(events, runLogsDir);
    expect(groups).toHaveLength(2);

    const doctorGroup = groups.find((g) => g.key === "doctor.fail");
    expect(doctorGroup?.examples[0].snippet).toContain("doctor stack trace");
    expect(doctorGroup?.examples[0].message).toContain("doctor failed");

    const taskGroup = groups.find((g) => g.key === "task.failed");
    expect(taskGroup?.examples[0].message).toContain("worker error");
  });
});
