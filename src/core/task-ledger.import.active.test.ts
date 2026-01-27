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
  it("imports completed tasks with merge and integration doctor pass", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    const paths = createPathsContext({ myceliumHome: temporaryHomeDirectory });

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
      paths,
    });

    expect(result.imported.sort()).toEqual(["101", "102"]);
    expect(result.skipped).toEqual([]);
    expect(result.skippedDetails).toEqual([]);

    const ledger = await loadTaskLedger(projectName, paths);
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
});
