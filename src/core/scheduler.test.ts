import { describe, expect, it, vi } from "vitest";

import { buildBatches, buildGreedyBatch, topologicalReady } from "./scheduler.js";
import type { TaskSpec } from "./task-manifest.js";

describe("scheduler", () => {
  it("allows read/read locks to share a batch", () => {
    const t1 = createTask("001", { reads: ["db"] });
    const t2 = createTask("002", { reads: ["db"] });

    const { batch, remaining } = buildGreedyBatch([t1, t2], 5);

    expect(batch.tasks.map(taskId)).toEqual(["001", "002"]);
    expect(remaining).toHaveLength(0);
  });

  it("blocks read/write conflicts", () => {
    const reader = createTask("001", { reads: ["cache"] });
    const writer = createTask("002", { writes: ["cache"] });

    const { batch, remaining } = buildGreedyBatch([reader, writer], 5);

    expect(batch.tasks.map(taskId)).toEqual(["001"]);
    expect(remaining.map(taskId)).toEqual(["002"]);
  });

  it("blocks write/read conflicts", () => {
    const writer = createTask("001", { writes: ["cache"] });
    const reader = createTask("002", { reads: ["cache"] });

    const { batch, remaining } = buildGreedyBatch([writer, reader], 5);

    expect(batch.tasks.map(taskId)).toEqual(["001"]);
    expect(remaining.map(taskId)).toEqual(["002"]);
  });

  it("blocks write/write conflicts", () => {
    const firstWriter = createTask("001", { writes: ["cache"] });
    const secondWriter = createTask("002", { writes: ["cache"] });

    const { batch, remaining } = buildGreedyBatch([firstWriter, secondWriter], 5);

    expect(batch.tasks.map(taskId)).toEqual(["001"]);
    expect(remaining.map(taskId)).toEqual(["002"]);
  });

  it("builds deterministic multi-batch schedules", () => {
    const tasks = [
      createTask("003", { writes: ["db"] }),
      createTask("002", { writes: ["cache"] }),
      createTask("004", { reads: ["logs"] }),
      createTask("001", { reads: ["cache"] }),
    ];

    const batches = buildBatches(tasks, 2);
    const batchIds = batches.map((batch) => batch.tasks.map(taskId));

    expect(batchIds).toEqual([
      ["001", "003"],
      ["002", "004"],
    ]);
  });

  it("returns normalized locks for batches", () => {
    const t1 = createTask("001", { reads: ["logs"], writes: ["cache"] });
    const t2 = createTask("002", { reads: ["logs"] });

    const { batch } = buildGreedyBatch([t1, t2], 2);

    expect(batch.locks.reads).toEqual(["logs"]);
    expect(batch.locks.writes).toEqual(["cache"]);
  });

  it("sorts ready tasks by id while filtering dependencies", () => {
    const tasks = [createTask("010", {}, ["2"]), createTask("2"), createTask("3", {}, ["9"])];

    const ready = topologicalReady(tasks, new Set(["2"]));

    expect(ready.map(taskId)).toEqual(["2", "010"]);
  });

  it("wraps placement failures with UserFacingError", async () => {
    vi.resetModules();
    vi.doMock("./task-manifest.js", async () => {
      const actual =
        await vi.importActual<typeof import("./task-manifest.js")>("./task-manifest.js");
      return {
        ...actual,
        locksConflict: () => true,
      };
    });

    try {
      const { buildGreedyBatch: buildGreedyBatchWithMock } = await import("./scheduler.js");
      const { UserFacingError } = await import("./errors.js");

      const task = createTask("001", { writes: ["db"] });

      let error: unknown;
      try {
        buildGreedyBatchWithMock([task], 2);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(UserFacingError);

      const userError = error as InstanceType<typeof UserFacingError>;
      expect(userError.title).toBe("Scheduler placement failed.");
      expect(userError.message).toBe("No tasks could be placed into a runnable batch.");
      expect(userError.hint).toBe(
        "Review task locks and configured resources, then rerun with --debug for details.",
      );
      expect(userError.cause).toBeInstanceOf(Error);
      const cause = userError.cause as Error;
      expect(cause.message).toContain("Scheduler could not place any tasks into a batch");
      expect(cause.message).toContain("001 Task 001");
    } finally {
      vi.unmock("./task-manifest.js");
      vi.resetModules();
    }
  });
});

function createTask(
  id: string,
  locks: { reads?: string[]; writes?: string[] } = {},
  dependencies: string[] = [],
): TaskSpec {
  return {
    manifest: {
      id,
      name: `Task ${id}`,
      description: `Task ${id} description`,
      estimated_minutes: 5,
      dependencies,
      locks: { reads: locks.reads ?? [], writes: locks.writes ?? [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "echo ok" },
    },
    taskDirName: `${id}-task`,
    stage: "legacy",
    slug: `task-${id}`,
  };
}

function taskId(task: TaskSpec): string {
  return task.manifest.id;
}
