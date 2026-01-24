import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskError } from "../core/errors.js";
import { loadTaskSpecs } from "../core/task-loader.js";
import { resolveTaskDir } from "../core/task-layout.js";

const tempRoots: string[] = [];

const baseManifest = {
  name: "Example Task",
  description: "Example description",
  estimated_minutes: 10,
  locks: { reads: [], writes: [] },
  files: { reads: [], writes: [] },
  affected_tests: [],
  verify: { doctor: "npm test" },
};

afterEach(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe("loadTaskSpecs", () => {
  it("loads manifests and sorts numerically by id", async () => {
    const { root, tasksDir } = createLegacyTasksDir();

    writeTask(tasksDir, "010", {
      ...baseManifest,
      id: "010",
      name: "Second Task",
    });
    writeTask(tasksDir, "2", {
      ...baseManifest,
      id: "2",
      name: "First Task",
    });

    const { tasks, errors } = await loadTaskSpecs(root, ".tasks");

    expect(errors).toHaveLength(0);
    expect(tasks.map((t) => t.manifest.id)).toEqual(["2", "010"]);
    expect(tasks[0].slug).toBe("first-task");
    expect(tasks[1].slug).toBe("second-task");
  });

  it("validates resource locks against known resources", async () => {
    const { root, tasksDir } = createLegacyTasksDir();

    writeTask(tasksDir, "001", {
      ...baseManifest,
      id: "001",
      locks: { reads: ["backend"], writes: ["unknown"] },
    });

    await expect(
      loadTaskSpecs(root, ".tasks", { knownResources: ["backend", "frontend"] }),
    ).rejects.toBeInstanceOf(TaskError);
  });

  it("surfaces schema errors without throwing when strict=false", async () => {
    const { root, tasksDir } = createLegacyTasksDir();

    writeTask(tasksDir, "003", {
      ...baseManifest,
      id: "003",
      description: undefined,
      estimated_minutes: undefined,
    });

    const { tasks, errors } = await loadTaskSpecs(root, ".tasks", { strict: false });

    expect(tasks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].issues.some((i) => i.includes("description"))).toBe(true);
    expect(errors[0].issues.some((i) => i.includes("estimated_minutes"))).toBe(true);
  });

  it("requires verify.fast when tdd_mode is strict", async () => {
    const { root, tasksDir } = createLegacyTasksDir();

    writeTask(tasksDir, "004", {
      ...baseManifest,
      id: "004",
      tdd_mode: "strict",
      test_paths: ["tests/**"],
      verify: { doctor: "npm test" },
    });

    await expect(loadTaskSpecs(root, ".tasks")).rejects.toBeInstanceOf(TaskError);
  });

  it("loads tasks from backlog and active when backlog exists", async () => {
    const { root, tasksDir, backlogDir, activeDir, archiveDir } = createKanbanTasksDir();

    writeTask(backlogDir, "002", {
      ...baseManifest,
      id: "002",
      name: "Backlog Task",
    });
    writeTask(activeDir, "001", {
      ...baseManifest,
      id: "001",
      name: "Active Task",
    });
    writeTask(archiveDir, "003", {
      ...baseManifest,
      id: "003",
      name: "Archived Task",
    });

    const { tasks, errors } = await loadTaskSpecs(root, ".tasks");
    const relativeDirs = tasks.map((task) =>
      path.relative(
        tasksDir,
        resolveTaskDir({ tasksRoot: tasksDir, stage: task.stage, taskDirName: task.taskDirName }),
      ),
    );

    expect(errors).toHaveLength(0);
    expect(tasks.map((task) => task.manifest.id)).toEqual(["001", "002"]);
    expect(tasks.map((task) => task.stage)).toEqual(["active", "backlog"]);
    expect(relativeDirs).toEqual([
      path.join("active", "001-task"),
      path.join("backlog", "002-task"),
    ]);
  });
});

function createLegacyTasksDir(): { root: string; tasksDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-loader-"));
  tempRoots.push(root);

  const tasksDir = path.join(root, ".tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir };
}

function createKanbanTasksDir(): {
  root: string;
  tasksDir: string;
  backlogDir: string;
  activeDir: string;
  archiveDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-loader-"));
  tempRoots.push(root);

  const tasksDir = path.join(root, ".tasks");
  const backlogDir = path.join(tasksDir, "backlog");
  const activeDir = path.join(tasksDir, "active");
  const archiveDir = path.join(tasksDir, "archive");

  fs.mkdirSync(backlogDir, { recursive: true });
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  return { root, tasksDir, backlogDir, activeDir, archiveDir };
}

function writeTask(tasksDir: string, id: string, manifest: Record<string, unknown>): void {
  const dir = path.join(tasksDir, `${id}-task`);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "spec.md"), "# Spec\n");
}
