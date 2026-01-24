import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractComponents } from "../control-plane/extract/components.js";
import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import {
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../control-plane/integration/derived-scope.js";
import { createEmptyModel, type ControlPlaneModel } from "../control-plane/model/schema.js";
import { resolveSurfacePatterns } from "../control-plane/policy/surface-detect.js";
import { buildGreedyBatch } from "../core/scheduler.js";
import {
  normalizeLocks,
  type NormalizedLocks,
  type TaskManifest,
  type TaskSpec,
} from "../core/task-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");



// =============================================================================
// HELPERS
// =============================================================================

async function buildControlPlaneModel(repoRoot: string): Promise<ControlPlaneModel> {
  const { components } = await extractComponents(repoRoot);
  const ownership = buildOwnershipIndex(components);
  const model = createEmptyModel();
  model.components = components;
  model.ownership = ownership;
  return model;
}

function buildManifest(overrides: Partial<TaskManifest>): TaskManifest {
  return {
    id: "001",
    name: "Scheduler task",
    description: "Lock mode scheduling test.",
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: [] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "echo ok" },
    ...overrides,
  };
}

function createTask(id: string, overrides: Partial<TaskManifest>): TaskSpec {
  const manifest = buildManifest({
    id,
    name: `Task ${id}`,
    description: `Task ${id} description`,
    ...overrides,
  });

  return {
    manifest,
    taskDirName: `${id}-task`,
    stage: "legacy",
    slug: `task-${id}`,
  };
}

function taskId(task: TaskSpec): string {
  return task.manifest.id;
}

async function deriveReport(
  task: TaskSpec,
  model: ControlPlaneModel,
  options?: {
    surfaceLocksEnabled?: boolean;
  },
): Promise<DerivedScopeReport> {
  return await deriveTaskWriteScopeReport({
    manifest: task.manifest,
    model,
    snapshotPath: FIXTURE_REPO,
    componentResourcePrefix: "component:",
    fallbackResource: "repo-root",
    surfaceLocksEnabled: options?.surfaceLocksEnabled,
    surfacePatterns: resolveSurfacePatterns(),
  });
}

function buildDerivedLockMap(
  reports: Array<{ taskId: string; locks: NormalizedLocks }>,
): Map<string, NormalizedLocks> {
  return new Map(reports.map((entry) => [entry.taskId, entry.locks]));
}



// =============================================================================
// TESTS
// =============================================================================

describe("scheduler lock mode", () => {
  it("batches tasks by derived locks when enabled", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const taskOne = createTask("001", {
      locks: { reads: [], writes: ["repo-root"] },
      files: { reads: [], writes: ["apps/web/src/index.ts"] },
    });
    const taskTwo = createTask("002", {
      locks: { reads: [], writes: ["repo-root"] },
      files: { reads: [], writes: ["packages/utils/src/index.ts"] },
    });

    const declared = buildGreedyBatch([taskOne, taskTwo], 2);
    expect(declared.batch.tasks.map(taskId)).toEqual(["001"]);
    expect(declared.remaining.map(taskId)).toEqual(["002"]);

    const reportOne = await deriveReport(taskOne, model);
    const reportTwo = await deriveReport(taskTwo, model);
    const derivedLocks = buildDerivedLockMap([
      { taskId: taskOne.manifest.id, locks: normalizeLocks(reportOne.derived_locks) },
      { taskId: taskTwo.manifest.id, locks: normalizeLocks(reportTwo.derived_locks) },
    ]);

    const derived = buildGreedyBatch(
      [taskOne, taskTwo],
      2,
      (task) => derivedLocks.get(task.manifest.id) ?? normalizeLocks(task.manifest.locks),
    );

    expect(derived.batch.tasks.map(taskId)).toEqual(["001", "002"]);
    expect(derived.remaining).toHaveLength(0);
  });

  it("falls back to the repo-root lock on low confidence", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const task = createTask("003", {
      files: { reads: [], writes: ["package.json"] },
    });

    const report = await deriveReport(task, model);

    expect(report.confidence).toBe("low");
    expect(report.derived_locks.writes).toEqual(["repo-root"]);
  });

  it("adds surface locks when enabled", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const task = createTask("004", {
      files: { reads: [], writes: ["apps/web/src/index.ts"] },
    });

    const report = await deriveReport(task, model, { surfaceLocksEnabled: true });

    expect(report.derived_locks.writes).toContain("surface:acme-web-app");
  });

  it("serializes overlapping surface locks in derived mode", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const taskOne = createTask("005", {
      files: { reads: [], writes: ["apps/web/src/index.ts"] },
    });
    const taskTwo = createTask("006", {
      files: { reads: [], writes: ["apps/web/src/index.ts"] },
    });

    const reportOne = await deriveReport(taskOne, model, { surfaceLocksEnabled: true });
    const reportTwo = await deriveReport(taskTwo, model, { surfaceLocksEnabled: true });

    const surfaceLocks = buildDerivedLockMap([
      {
        taskId: taskOne.manifest.id,
        locks: normalizeLocks({
          reads: [],
          writes: reportOne.derived_locks.writes.filter((lock) =>
            lock.startsWith("surface:"),
          ),
        }),
      },
      {
        taskId: taskTwo.manifest.id,
        locks: normalizeLocks({
          reads: [],
          writes: reportTwo.derived_locks.writes.filter((lock) =>
            lock.startsWith("surface:"),
          ),
        }),
      },
    ]);

    const derived = buildGreedyBatch(
      [taskOne, taskTwo],
      2,
      (task) => surfaceLocks.get(task.manifest.id) ?? normalizeLocks(task.manifest.locks),
    );

    expect(derived.batch.tasks.map(taskId)).toEqual(["005"]);
    expect(derived.remaining.map(taskId)).toEqual(["006"]);
  });
});
