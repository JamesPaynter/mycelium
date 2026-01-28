import { afterEach, describe, expect, it, vi } from "vitest";

import { UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import {
  applyTaskStatusOverride,
  completeBatch,
  createRunState,
  markTaskComplete,
  markTaskFailed,
  markTaskValidated,
  resetRunningTasks,
  resetTaskToPending,
  startBatch,
} from "./state.js";

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
    markTaskValidated(state, "001");
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

    markTaskValidated(state, "010");
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

  it("overrides task status to complete and clears review metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-03T00:00:00Z"));

    const state = createRunState({
      runId: "run-override-1",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["900"],
    });

    state.tasks["900"].status = "failed";
    state.tasks["900"].last_error = "boom";
    state.tasks["900"].human_review = {
      validator: "test",
      reason: "needs review",
      summary: "summary",
    };

    applyTaskStatusOverride(state, "900", { status: "complete" });

    expect(state.tasks["900"].status).toBe("complete");
    expect(state.tasks["900"].completed_at).toBe("2024-03-03T00:00:00.000Z");
    expect(state.tasks["900"].last_error).toBeUndefined();
    expect(state.tasks["900"].human_review).toBeUndefined();
  });

  it("blocks overriding a running task without force", () => {
    const state = createRunState({
      runId: "run-override-2",
      project: "demo",
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["901"],
    });

    state.tasks["901"].status = "running";

    let error: unknown;
    try {
      applyTaskStatusOverride(state, "901", { status: "pending" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(UserFacingError);
    const userError = error as UserFacingError;
    expect(userError.code).toBe(USER_FACING_ERROR_CODES.task);
    expect(userError.title).toBe("Run state transition invalid.");
    expect(userError.message).toBe("Cannot override running task 901 without --force");
    expect(userError.hint).toContain("mycelium resume");
    expect(userError.hint).toContain("mycelium clean");
    expect(userError.cause).toBeInstanceOf(Error);
  });
});
