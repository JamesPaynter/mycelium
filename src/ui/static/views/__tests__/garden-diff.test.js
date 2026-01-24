import { describe, expect, it } from "vitest";

import { snapshotDiff, selectVisibleTaskIds } from "../garden.js";

function buildTask({
  id,
  status,
  role,
  tokensUsed = 0,
  cost = 0,
  startedAt = 0,
  workstationId = null,
} = {}) {
  return {
    id,
    status,
    role,
    tokensUsed,
    cost,
    startedAt,
    workstationId,
  };
}

describe("snapshotDiff", () => {
  it("reports added, removed, and changed tasks with per-field flags", () => {
    const prevById = new Map([
      [
        "alpha",
        buildTask({
          id: "alpha",
          status: "running",
          role: "researcher",
          workstationId: "researcher",
        }),
      ],
      [
        "beta",
        buildTask({
          id: "beta",
          status: "running",
          role: "coder",
          workstationId: "coder",
        }),
      ],
    ]);

    const nextTasks = [
      buildTask({
        id: "alpha",
        status: "needs_review",
        role: "researcher",
        workstationId: "reviewer",
      }),
      buildTask({
        id: "charlie",
        status: "running",
        role: "coder",
        workstationId: "coder",
      }),
    ];

    const diff = snapshotDiff(prevById, nextTasks);

    expect(diff.added.has("charlie")).toBe(true);
    expect(diff.removed.has("beta")).toBe(true);
    expect(diff.changed.has("alpha")).toBe(true);

    const alphaChanges = diff.changesById.get("alpha");
    expect(alphaChanges).toEqual({
      statusChanged: true,
      roleChanged: false,
      workstationChanged: true,
      becameTerminal: false,
      becameActive: false,
    });

    const charlieChanges = diff.changesById.get("charlie");
    expect(charlieChanges).toEqual({
      statusChanged: true,
      roleChanged: true,
      workstationChanged: true,
      becameTerminal: false,
      becameActive: true,
    });
  });

  it("flags terminal transitions explicitly", () => {
    const prevById = new Map([
      [
        "delta",
        buildTask({
          id: "delta",
          status: "running",
          role: "coder",
          workstationId: "coder",
        }),
      ],
    ]);

    const nextTasks = [
      buildTask({
        id: "delta",
        status: "failed",
        role: "coder",
        workstationId: null,
      }),
    ];

    const diff = snapshotDiff(prevById, nextTasks);

    expect(diff.changed.has("delta")).toBe(true);
    expect(diff.changesById.get("delta").becameTerminal).toBe(true);
  });
});

describe("selectVisibleTaskIds", () => {
  it("pins changed tasks ahead of lower priority entries", () => {
    const tasks = [
      buildTask({
        id: "alpha",
        status: "running",
        tokensUsed: 10,
        cost: 5,
        startedAt: 10,
      }),
      buildTask({
        id: "beta",
        status: "running",
        tokensUsed: 6,
        cost: 2,
        startedAt: 6,
      }),
      buildTask({
        id: "charlie",
        status: "running",
        tokensUsed: 1,
        cost: 1,
        startedAt: 1,
      }),
    ];

    const pinnedTaskIds = new Set(["charlie"]);
    const visible = selectVisibleTaskIds({
      candidates: tasks,
      pinnedTaskIds,
      maxVisible: 2,
    });

    expect(visible.has("charlie")).toBe(true);
    expect(visible.size).toBe(2);
  });
});
