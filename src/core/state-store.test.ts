import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import { createPathsContext, orchestratorLogPath } from "./paths.js";
import {
  findLatestRunId,
  loadRunState,
  loadRunStateForProject,
  saveRunState,
  summarizeRunState,
  StateStore,
} from "./state-store.js";
import { createRunState, startBatch, type RunState } from "./state.js";

afterEach(() => {
  vi.useRealTimers();
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

  it("recovers stale running runs on load and logs an event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-04-01T00:00:00Z"));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-stale-"));
    const paths = createPathsContext({ myceliumHome: tmpDir });

    try {
      const project = "demo-stale";
      const runId = "run-stale";
      const store = new StateStore(project, runId, paths);
      const state = createRunState({
        runId,
        project,
        repoPath: "/repo",
        mainBranch: "main",
        taskIds: ["001"],
      });
      startBatch(state, { batchId: 1, taskIds: ["001"] });
      await store.save(state);

      vi.setSystemTime(new Date("2024-04-01T00:20:00Z"));
      const loaded = await store.load();

      expect(loaded.status).toBe("paused");
      expect(loaded.tasks["001"].status).toBe("pending");
      expect(loaded.tasks["001"].last_error).toMatch(/Stale recovery/);

      const events = await readJsonl(orchestratorLogPath(project, runId, paths));
      expect(events.some((event) => event.type === "run.stale_recovery")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds the latest run id and loads matching state", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-home-"));
    const paths = createPathsContext({ myceliumHome: tmpHome });

    try {
      const project = "demo-project";
      const first = new StateStore(project, "001", paths);
      const second = new StateStore(project, "002", paths);

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

      const latest = await findLatestRunId(project, paths);
      expect(latest).toBe("002");

      const resolved = await loadRunStateForProject(project, undefined, paths);
      expect(resolved?.runId).toBe("002");
      expect(resolved?.state.run_id).toBe("002");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("wraps invalid run state load errors with UserFacingError", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-invalid-"));
    const statePath = path.join(tmpDir, "run-bad.json");

    try {
      fs.writeFileSync(statePath, "{}\n", "utf8");
      const store = new StateStore("demo", "bad-load", statePath);

      let error: unknown;
      try {
        await store.load();
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(UserFacingError);
      const userError = error as UserFacingError;
      expect(userError.code).toBe(USER_FACING_ERROR_CODES.task);
      expect(userError.title).toBe("Run state load failed.");
      expect(userError.message).toBe(`Unable to load run state at ${statePath}.`);
      expect(userError.hint).toContain("mycelium resume");
      expect(userError.hint).toContain("mycelium clean");
      expect(userError.cause).toBeInstanceOf(Error);
      const cause = userError.cause as Error;
      expect(cause.message).toContain(`Invalid run state at ${statePath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("wraps invalid run state save errors with UserFacingError", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-invalid-"));
    const statePath = path.join(tmpDir, "run-save.json");

    try {
      const store = new StateStore("demo", "bad-save", statePath);
      const invalidState = { run_id: "bad-save" } as RunState;

      let error: unknown;
      try {
        await store.save(invalidState);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(UserFacingError);
      const userError = error as UserFacingError;
      expect(userError.code).toBe(USER_FACING_ERROR_CODES.task);
      expect(userError.title).toBe("Run state save failed.");
      expect(userError.message).toBe(`Unable to save run state at ${statePath}.`);
      expect(userError.hint).toContain("mycelium resume");
      expect(userError.hint).toContain("mycelium clean");
      expect(userError.cause).toBeInstanceOf(Error);
      const cause = userError.cause as Error;
      expect(cause.message).toContain("Cannot save run state");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

type JsonlEvent = { type?: string };

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((line: string) => JSON.parse(line) as JsonlEvent);
}
