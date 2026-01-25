import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { taskLedgerPath } from "./paths.js";
import {
  computeTaskFingerprint,
  importLedgerFromRunState,
  loadTaskLedger,
  saveTaskLedger,
} from "./task-ledger.js";
import { createRunState } from "./state.js";
import type { TaskSpec } from "./task-manifest.js";
import type { TaskLedger } from "./task-ledger.js";

const originalHome = process.env.MYCELIUM_HOME;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;

  if (originalHome === undefined) {
    delete process.env.MYCELIUM_HOME;
  } else {
    process.env.MYCELIUM_HOME = originalHome;
  }
});


// =============================================================================
// HELPERS
// =============================================================================

function makeTemporaryDirectory(prefix: string): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}


// =============================================================================
// TESTS
// =============================================================================

describe("task ledger fingerprint", () => {
  it("keeps fingerprints stable across manifest key ordering", async () => {
    const temporaryDirectory = makeTemporaryDirectory("task-ledger-fingerprint-");
    const manifestPathFirst = path.join(temporaryDirectory, "manifest-a.json");
    const manifestPathSecond = path.join(temporaryDirectory, "manifest-b.json");
    const specPathFirst = path.join(temporaryDirectory, "spec-a.md");
    const specPathSecond = path.join(temporaryDirectory, "spec-b.md");

    const manifestWithDefaultOrder = {
      id: "210",
      name: "Ledger Task",
      description: "Manifest ordering test",
      estimated_minutes: 30,
      dependencies: ["003", "001"],
      locks: { reads: ["db"], writes: [] },
      files: { reads: ["src/a.ts"], writes: ["src/b.ts"] },
      affected_tests: ["test/a.test.ts"],
      test_paths: ["test/a.test.ts"],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    const manifestWithReorderedKeys = {
      verify: { doctor: "npm test" },
      tdd_mode: "off",
      test_paths: ["test/a.test.ts"],
      affected_tests: ["test/a.test.ts"],
      files: { writes: ["src/b.ts"], reads: ["src/a.ts"] },
      locks: { writes: [], reads: ["db"] },
      dependencies: ["003", "001"],
      estimated_minutes: 30,
      description: "Manifest ordering test",
      name: "Ledger Task",
      id: "210",
    };

    await fse.writeFile(
      manifestPathFirst,
      JSON.stringify(manifestWithDefaultOrder, null, 2),
      "utf8",
    );
    await fse.writeFile(
      manifestPathSecond,
      JSON.stringify(manifestWithReorderedKeys, null, 2),
      "utf8",
    );

    const specWithUnixLineEndings = "Do the work.\n\n- Step one\n";
    const specWithWindowsLineEndings = "Do the work.\r\n\r\n- Step one\r\n";
    await fse.writeFile(specPathFirst, specWithUnixLineEndings, "utf8");
    await fse.writeFile(specPathSecond, specWithWindowsLineEndings, "utf8");

    const firstFingerprint = await computeTaskFingerprint({
      manifestPath: manifestPathFirst,
      specPath: specPathFirst,
    });
    const secondFingerprint = await computeTaskFingerprint({
      manifestPath: manifestPathSecond,
      specPath: specPathSecond,
    });

    expect(firstFingerprint).toBe(secondFingerprint);
  });

  it("changes fingerprint when spec content changes", async () => {
    const temporaryDirectory = makeTemporaryDirectory("task-ledger-fingerprint-change-");
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const specPathInitial = path.join(temporaryDirectory, "spec-a.md");
    const specPathUpdated = path.join(temporaryDirectory, "spec-b.md");

    const manifest = {
      id: "210",
      name: "Ledger Task",
      description: "Spec change test",
      estimated_minutes: 30,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    await fse.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fse.writeFile(specPathInitial, "Do the work.\n\n- Step one\n", "utf8");
    await fse.writeFile(specPathUpdated, "Do the work.\n\n- Step two\n", "utf8");

    const firstFingerprint = await computeTaskFingerprint({
      manifestPath,
      specPath: specPathInitial,
    });
    const secondFingerprint = await computeTaskFingerprint({
      manifestPath,
      specPath: specPathUpdated,
    });

    expect(firstFingerprint).not.toBe(secondFingerprint);
  });
});

describe("task ledger storage", () => {
  it("roundtrips ledger load and save", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    process.env.MYCELIUM_HOME = temporaryHomeDirectory;

    const projectName = "demo-project";
    const ledger: TaskLedger = {
      schemaVersion: 1,
      updatedAt: "2024-03-01T00:00:00.000Z",
      tasks: {
        "210": {
          taskId: "210",
          status: "complete",
          fingerprint: "sha256:abc123",
          mergeCommit: "deadbeef",
          integrationDoctorPassed: true,
          completedAt: "2024-03-01T00:10:00.000Z",
          runId: "run-210",
          source: "executor",
        },
      },
    };

    await saveTaskLedger(projectName, ledger);
    const loaded = await loadTaskLedger(projectName);

    expect(loaded).toEqual(ledger);
    expect(fs.existsSync(taskLedgerPath(projectName))).toBe(true);
  });
});

describe("task ledger import", () => {
  it("imports completed tasks with merge and integration doctor pass", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    process.env.MYCELIUM_HOME = temporaryHomeDirectory;

    const repoPath = makeTemporaryDirectory("task-ledger-repo-");
    const tasksRoot = path.join(repoPath, ".mycelium", "tasks");
    const taskSpecs: TaskSpec[] = [
      {
        manifest: {
          id: "101",
          name: "Alpha Task",
          description: "Alpha description",
          estimated_minutes: 10,
          dependencies: [],
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "npm test" },
        },
        taskDirName: "101-alpha-task",
        stage: "active",
        slug: "alpha-task",
      },
      {
        manifest: {
          id: "102",
          name: "Beta Task",
          description: "Beta description",
          estimated_minutes: 12,
          dependencies: [],
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "npm test" },
        },
        taskDirName: "102-beta-task",
        stage: "active",
        slug: "beta-task",
      },
    ];

    for (const task of taskSpecs) {
      const taskDir = path.join(tasksRoot, "active", task.taskDirName);
      await fse.ensureDir(taskDir);
      await fse.writeFile(
        path.join(taskDir, "manifest.json"),
        JSON.stringify(task.manifest, null, 2),
        "utf8",
      );
      await fse.writeFile(path.join(taskDir, "spec.md"), `Spec for ${task.manifest.id}\n`, "utf8");
    }

    const projectName = "demo-project";
    const runId = "run-101";
    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: taskSpecs.map((task) => task.manifest.id),
    });

    state.status = "complete";
    state.batches = [
      {
        batch_id: 1,
        status: "complete",
        tasks: taskSpecs.map((task) => task.manifest.id),
        started_at: "2024-03-01T00:00:00.000Z",
        completed_at: "2024-03-01T00:05:00.000Z",
        merge_commit: "deadbeef",
        integration_doctor_passed: true,
      },
    ];
    state.tasks["101"].status = "complete";
    state.tasks["101"].batch_id = 1;
    state.tasks["101"].completed_at = "2024-03-01T00:04:00.000Z";
    state.tasks["102"].status = "skipped";
    state.tasks["102"].batch_id = 1;
    state.tasks["102"].completed_at = "2024-03-01T00:05:00.000Z";

    const result = await importLedgerFromRunState({
      projectName,
      repoPath,
      runId,
      tasks: taskSpecs,
      state,
    });

    expect(result.imported.sort()).toEqual(["101", "102"]);
    expect(result.skipped).toEqual([]);
    expect(result.skippedDetails).toEqual([]);

    const ledger = await loadTaskLedger(projectName);
    expect(ledger).not.toBeNull();

    const alphaFingerprint = await computeTaskFingerprint({
      manifestPath: path.join(tasksRoot, "active", taskSpecs[0].taskDirName, "manifest.json"),
      specPath: path.join(tasksRoot, "active", taskSpecs[0].taskDirName, "spec.md"),
    });
    const betaFingerprint = await computeTaskFingerprint({
      manifestPath: path.join(tasksRoot, "active", taskSpecs[1].taskDirName, "manifest.json"),
      specPath: path.join(tasksRoot, "active", taskSpecs[1].taskDirName, "spec.md"),
    });

    expect(ledger?.tasks["101"]).toEqual({
      taskId: "101",
      status: "complete",
      fingerprint: alphaFingerprint,
      mergeCommit: "deadbeef",
      integrationDoctorPassed: true,
      completedAt: "2024-03-01T00:04:00.000Z",
      runId,
      source: "import-run",
    });
    expect(ledger?.tasks["102"]).toEqual({
      taskId: "102",
      status: "skipped",
      fingerprint: betaFingerprint,
      mergeCommit: "deadbeef",
      integrationDoctorPassed: true,
      completedAt: "2024-03-01T00:05:00.000Z",
      runId,
      source: "import-run",
    });
  });

  it("skips tasks without integration doctor pass", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    process.env.MYCELIUM_HOME = temporaryHomeDirectory;

    const repoPath = makeTemporaryDirectory("task-ledger-repo-");
    const tasksRoot = path.join(repoPath, ".mycelium", "tasks");
    const taskSpecs: TaskSpec[] = [
      {
        manifest: {
          id: "201",
          name: "Gamma Task",
          description: "Gamma description",
          estimated_minutes: 8,
          dependencies: [],
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "npm test" },
        },
        taskDirName: "201-gamma-task",
        stage: "active",
        slug: "gamma-task",
      },
    ];

    for (const task of taskSpecs) {
      const taskDir = path.join(tasksRoot, "active", task.taskDirName);
      await fse.ensureDir(taskDir);
      await fse.writeFile(
        path.join(taskDir, "manifest.json"),
        JSON.stringify(task.manifest, null, 2),
        "utf8",
      );
      await fse.writeFile(path.join(taskDir, "spec.md"), `Spec for ${task.manifest.id}\n`, "utf8");
    }

    const projectName = "demo-project";
    const runId = "run-201";
    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: ["201"],
    });

    state.status = "failed";
    state.batches = [
      {
        batch_id: 1,
        status: "failed",
        tasks: ["201"],
        started_at: "2024-03-01T00:00:00.000Z",
        completed_at: "2024-03-01T00:02:00.000Z",
        merge_commit: "badcafe",
        integration_doctor_passed: false,
      },
    ];
    state.tasks["201"].status = "complete";
    state.tasks["201"].batch_id = 1;
    state.tasks["201"].completed_at = "2024-03-01T00:02:00.000Z";

    const result = await importLedgerFromRunState({
      projectName,
      repoPath,
      runId,
      tasks: taskSpecs,
      state,
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["201"]);
    expect(result.skippedDetails).toEqual([
      { taskId: "201", reason: "integration doctor did not pass" },
    ]);
    expect(await loadTaskLedger(projectName)).toBeNull();
  });
});
