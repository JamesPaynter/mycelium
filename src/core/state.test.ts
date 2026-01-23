import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeBatch,
  createRunState,
  markTaskComplete,
  markTaskFailed,
  resetRunningTasks,
  resetTaskToPending,
  RunStateSchema,
  startBatch,
} from "./state.js";
import {
  findLatestRunId,
  loadRunState,
  loadRunStateForProject,
  summarizeRunState,
  saveRunState,
  StateStore,
} from "./state-store.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("state transitions", () => {
  it("starts batches and tracks task lifecycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-02T03:04:05Z"));

    const state = createRunState({
      runId: "run-1",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["001", "002"],
    });

    expect(state.tasks["001"].status).toBe("pending");
    expect(state.status).toBe("running");

    vi.setSystemTime(new Date("2024-01-02T03:10:00Z"));
    startBatch(state, { batchId: 1, taskIds: ["001", "002"] });
    expect(state.batches[0]).toMatchObject({
      batch_id: 1,
      status: "running",
      tasks: ["001", "002"],
      started_at: "2024-01-02T03:10:00.000Z",
    });
    expect(state.tasks["001"].batch_id).toBe(1);
    expect(state.tasks["001"].attempts).toBe(1);

    vi.setSystemTime(new Date("2024-01-02T03:30:00Z"));
    markTaskComplete(state, "001");
    markTaskFailed(state, "002", "boom");
    completeBatch(state, 1, "failed");

    expect(state.tasks["001"].completed_at).toBe("2024-01-02T03:30:00.000Z");
    expect(state.tasks["002"].status).toBe("failed");
    expect(state.tasks["002"].last_error).toBe("boom");
    expect(state.batches[0].status).toBe("failed");
    expect(state.batches[0].completed_at).toBe("2024-01-02T03:30:00.000Z");
  });

  it("resets running tasks to pending for recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-01T00:00:00Z"));

    const state = createRunState({
      runId: "run-2",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["010"],
    });

    startBatch(state, { batchId: 1, taskIds: ["010"] });
    state.tasks["010"].branch = "agent/010-work";
    state.tasks["010"].container_id = "container-123";
    state.batches[0].status = "running";

    vi.setSystemTime(new Date("2024-02-01T01:00:00Z"));
    resetRunningTasks(state, "resume requested");

    expect(state.tasks["010"]).toMatchObject({
      status: "pending",
      batch_id: undefined,
      branch: undefined,
      container_id: undefined,
      workspace: undefined,
      logs_dir: undefined,
      last_error: "resume requested",
    });
    expect(state.batches[0].status).toBe("failed");
    expect(state.batches[0].completed_at).toBe("2024-02-01T01:00:00.000Z");
  });

  it("resets a single running task without touching completed work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-02T02:00:00Z"));

    const state = createRunState({
      runId: "run-3",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["010", "011"],
    });

    startBatch(state, { batchId: 1, taskIds: ["010", "011"] });
    state.tasks["011"].branch = "agent/011-work";
    state.tasks["011"].container_id = "container-xyz";
    state.tasks["011"].workspace = "/tmp/workspace";
    state.tasks["011"].logs_dir = "/tmp/logs";

    markTaskComplete(state, "010");

    vi.setSystemTime(new Date("2024-02-02T02:30:00Z"));
    resetTaskToPending(state, "011", "container missing");

    expect(state.tasks["011"]).toMatchObject({
      status: "pending",
      branch: undefined,
      container_id: undefined,
      workspace: undefined,
      logs_dir: undefined,
      last_error: "container missing",
    });
    expect(state.tasks["010"].status).toBe("complete");
    expect(state.batches[0].status).toBe("running");
  });
});

describe("run state schema", () => {
  it("accepts legacy state without control_plane metadata", () => {
    const legacyState = {
      run_id: "legacy-run",
      project: "demo",
      repo_path: "/repo",
      main_branch: "main",
      started_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      status: "running",
      batches: [],
      tasks: {},
      tokens_used: 0,
      estimated_cost: 0,
    };

    const parsed = RunStateSchema.safeParse(legacyState);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.control_plane).toBeUndefined();
    }
  });
});

describe("state store", () => {
  it("persists state with atomic replace and updates timestamps", async () => {
    vi.useFakeTimers();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-"));
    const statePath = path.join(tmpDir, "run-demo.json");

    try {
      const state = createRunState({
        runId: "demo",
        project: "demo",
        repoPath: "/repo",
        mainBranch: "main",
        taskIds: ["001"],
      });

      vi.setSystemTime(new Date("2024-03-01T00:00:00Z"));
      await saveRunState(statePath, state);
      const firstUpdated = state.updated_at;

      vi.setSystemTime(new Date("2024-03-01T00:10:00Z"));
      state.status = "failed";
      await saveRunState(statePath, state);

      const loaded = await loadRunState(statePath);
      expect(loaded.status).toBe("failed");
      expect(loaded.updated_at).toBe("2024-03-01T00:10:00.000Z");
      expect(state.updated_at).not.toBe(firstUpdated);

      const tmpFiles = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers running tasks when requested", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-"));
    const statePath = path.join(tmpDir, "run-recover.json");

    try {
      const store = new StateStore("demo", "recover-test", statePath);
      const state = createRunState({
        runId: "recover-test",
        project: "demo",
        repoPath: "/repo",
        mainBranch: "main",
        taskIds: ["020"],
      });
      startBatch(state, { batchId: 1, taskIds: ["020"] });
      await store.save(state);

      const recovered = await store.loadAndRecover("crash recovery");
      expect(recovered.tasks["020"].status).toBe("pending");

      const reloaded = await loadRunState(statePath);
      expect(reloaded.tasks["020"].last_error).toBe("crash recovery");
      expect(reloaded.batches[0].status).toBe("failed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds the latest run id and loads matching state", async () => {
    const originalHome = process.env.MYCELIUM_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-home-"));
    process.env.MYCELIUM_HOME = tmpHome;

    try {
      const project = "demo-project";
      const first = new StateStore(project, "001");
      const second = new StateStore(project, "002");

      const baseState = {
        project,
        repoPath: "/repo",
        mainBranch: "main",
        taskIds: ["alpha"],
      };

      await first.save(createRunState({ ...baseState, runId: "001" }));
      fs.utimesSync(
        first.statePath,
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T00:00:00Z"),
      );

      await second.save(createRunState({ ...baseState, runId: "002" }));
      fs.utimesSync(
        second.statePath,
        new Date("2024-02-01T00:00:00Z"),
        new Date("2024-02-01T00:00:00Z"),
      );

      const latest = await findLatestRunId(project);
      expect(latest).toBe("002");

      const resolved = await loadRunStateForProject(project);
      expect(resolved?.runId).toBe("002");
      expect(resolved?.state.run_id).toBe("002");
    } finally {
      process.env.MYCELIUM_HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("summarizes run state for status output", () => {
    const state = createRunState({
      runId: "summary-1",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["001", "002", "003", "004"],
    });

    state.status = "failed";
    state.started_at = "2024-05-01T00:00:00.000Z";
    state.updated_at = "2024-05-01T01:00:00.000Z";

    state.tasks["001"].status = "complete";
    state.tasks["001"].attempts = 1;
    state.tasks["001"].branch = "feature/001-work";
    state.tasks["001"].thread_id = "thread-001";
    state.tasks["002"].status = "failed";
    state.tasks["002"].attempts = 2;
    state.tasks["003"].status = "running";
    state.tasks["003"].attempts = 1;
    state.tasks["003"].thread_id = "thread-003";
    state.tasks["004"].status = "skipped";

    state.batches = [
      { batch_id: 1, status: "complete", tasks: ["001", "002"] },
      { batch_id: 2, status: "running", tasks: ["003"] },
      { batch_id: 3, status: "failed", tasks: ["004"] },
    ];

    const summary = summarizeRunState(state);

    expect(summary).toMatchObject({
      runId: "summary-1",
      status: "failed",
      startedAt: "2024-05-01T00:00:00.000Z",
      updatedAt: "2024-05-01T01:00:00.000Z",
      batchCounts: {
        total: 3,
        pending: 0,
        running: 1,
        complete: 1,
        failed: 1,
      },
      taskCounts: {
        total: 4,
        pending: 0,
        running: 1,
        complete: 1,
        failed: 1,
        skipped: 1,
      },
    });

    expect(summary.tasks).toEqual([
      {
        id: "001",
        status: "complete",
        attempts: 1,
        branch: "feature/001-work",
        threadId: "thread-001",
      },
      { id: "002", status: "failed", attempts: 2, branch: null, threadId: null },
      { id: "003", status: "running", attempts: 1, branch: null, threadId: "thread-003" },
      { id: "004", status: "skipped", attempts: 0, branch: null, threadId: null },
    ]);
  });
});
