import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TaskError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";
import { moveTaskDir, resolveTasksBacklogDir } from "../core/task-layout.js";

describe("moveTaskDir", () => {
  it("wraps missing task directory errors with user-facing messaging", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-layout-"));
    const tasksRoot = path.join(root, ".tasks");
    const backlogDir = resolveTasksBacklogDir(tasksRoot);

    try {
      fs.mkdirSync(backlogDir, { recursive: true });

      let error: unknown;
      try {
        await moveTaskDir({
          tasksRoot,
          fromStage: "backlog",
          toStage: "active",
          taskDirName: "001-task",
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(UserFacingError);
      const userError = error as UserFacingError;
      expect(userError.code).toBe(USER_FACING_ERROR_CODES.task);
      expect(userError.title).toBe("Task directory missing.");
      expect(userError.message).toBe("Task directory not found.");
      expect(userError.hint).toContain("mycelium plan");
      expect(userError.hint).toContain("tasks_dir");
      expect(userError.cause).toBeInstanceOf(TaskError);
      const cause = userError.cause as TaskError;
      expect(cause.message).toContain(path.join(tasksRoot, "backlog", "001-task"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
