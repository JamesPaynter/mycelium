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
  startBatch,
} from "./state.js";
import { loadRunState, saveRunState, StateStore } from "./state-store.js";

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
    startBatch(state, 1, ["001", "002"]);
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

    startBatch(state, 1, ["010"]);
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
      startBatch(state, 1, ["020"]);
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
});
