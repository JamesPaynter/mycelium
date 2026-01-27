import path from "node:path";

import fse from "fs-extra";
import { describe, expect, it } from "vitest";

import { createPathsContext } from "./paths.js";
import { createRunState } from "./state.js";
import { computeTaskFingerprint, importLedgerFromRunState, loadTaskLedger } from "./task-ledger.js";
import {
  makeTemporaryDirectory,
  registerTaskLedgerTempCleanup,
} from "./task-ledger.test-helpers.js";
import type { TaskSpec } from "./task-manifest.js";

registerTaskLedgerTempCleanup();

describe("task ledger import", () => {
  it("imports completed tasks from archive when active files are missing", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    const paths = createPathsContext({ myceliumHome: temporaryHomeDirectory });

    const repoPath = makeTemporaryDirectory("task-ledger-repo-");
    const tasksRoot = path.join(repoPath, ".mycelium", "tasks");
    const taskSpecs: TaskSpec[] = [
      {
        manifest: {
          id: "301",
          name: "Archive Alpha",
          description: "Archive alpha description",
          estimated_minutes: 9,
          dependencies: [],
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "npm test" },
        },
        taskDirName: "301-archive-alpha",
        stage: "active",
        slug: "archive-alpha",
      },
      {
        manifest: {
          id: "302",
          name: "Archive Beta",
          description: "Archive beta description",
          estimated_minutes: 11,
          dependencies: [],
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "npm test" },
        },
        taskDirName: "302-archive-beta",
        stage: "active",
        slug: "archive-beta",
      },
    ];

    const projectName = "demo-project";
    const runId = "run-archive";
    for (const task of taskSpecs) {
      const taskDir = path.join(tasksRoot, "archive", runId, task.taskDirName);
      await fse.ensureDir(taskDir);
      await fse.writeFile(
        path.join(taskDir, "manifest.json"),
        JSON.stringify(task.manifest, null, 2),
        "utf8",
      );
      await fse.writeFile(path.join(taskDir, "spec.md"), `Spec for ${task.manifest.id}\n`, "utf8");
    }

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
        merge_commit: "feedbead",
        integration_doctor_passed: true,
      },
    ];
    state.tasks["301"].status = "complete";
    state.tasks["301"].batch_id = 1;
    state.tasks["301"].completed_at = "2024-03-01T00:04:00.000Z";
    state.tasks["302"].status = "skipped";
    state.tasks["302"].batch_id = 1;
    state.tasks["302"].completed_at = "2024-03-01T00:05:00.000Z";

    const result = await importLedgerFromRunState({
      projectName,
      repoPath,
      runId,
      tasks: taskSpecs,
      state,
      paths,
    });

    expect(result.imported.sort()).toEqual(["301", "302"]);
    expect(result.skipped).toEqual([]);
    expect(result.skippedDetails).toEqual([]);

    const ledger = await loadTaskLedger(projectName, paths);
    expect(ledger).not.toBeNull();

    const alphaFingerprint = await computeTaskFingerprint({
      manifestPath: path.join(
        tasksRoot,
        "archive",
        runId,
        taskSpecs[0].taskDirName,
        "manifest.json",
      ),
      specPath: path.join(tasksRoot, "archive", runId, taskSpecs[0].taskDirName, "spec.md"),
    });
    const betaFingerprint = await computeTaskFingerprint({
      manifestPath: path.join(
        tasksRoot,
        "archive",
        runId,
        taskSpecs[1].taskDirName,
        "manifest.json",
      ),
      specPath: path.join(tasksRoot, "archive", runId, taskSpecs[1].taskDirName, "spec.md"),
    });

    expect(ledger?.tasks["301"]).toEqual({
      taskId: "301",
      status: "complete",
      fingerprint: alphaFingerprint,
      mergeCommit: "feedbead",
      integrationDoctorPassed: true,
      completedAt: "2024-03-01T00:04:00.000Z",
      runId,
      source: "import-run",
    });
    expect(ledger?.tasks["302"]).toEqual({
      taskId: "302",
      status: "skipped",
      fingerprint: betaFingerprint,
      mergeCommit: "feedbead",
      integrationDoctorPassed: true,
      completedAt: "2024-03-01T00:05:00.000Z",
      runId,
      source: "import-run",
    });
  });

  it("skips tasks without integration doctor pass", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    const paths = createPathsContext({ myceliumHome: temporaryHomeDirectory });

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
      paths,
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["201"]);
    expect(result.skippedDetails).toEqual([
      { taskId: "201", reason: "integration doctor did not pass" },
    ]);
    expect(await loadTaskLedger(projectName, paths)).toBeNull();
  });
});
