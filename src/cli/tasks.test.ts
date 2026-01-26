import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tasksImportRunCommand, tasksSetStatusCommand } from "./tasks.js";
import { ProjectConfigSchema } from "../core/config.js";
import { StateStore } from "../core/state-store.js";
import { createRunState } from "../core/state.js";
import { loadTaskLedger } from "../core/task-ledger.js";
import { buildTaskDirName } from "../core/task-manifest.js";

import type { ProjectConfig } from "../core/config.js";
import type { TaskManifest } from "../core/task-manifest.js";

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

  process.exitCode = undefined;
  vi.useRealTimers();
});

// =============================================================================
// HELPERS
// =============================================================================

function makeTemporaryDirectory(prefix: string): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}

function makeProjectConfig(repoPath: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    repo_path: repoPath,
    doctor: 'node -e "process.exit(0)"',
    resources: [{ name: "repo", paths: ["**/*"] }],
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock" },
  });
}

async function writeTaskSpec(tasksRoot: string, manifest: TaskManifest): Promise<void> {
  await fse.ensureDir(path.join(tasksRoot, "backlog"));
  const taskDirName = buildTaskDirName({ id: manifest.id, name: manifest.name });
  const taskDir = path.join(tasksRoot, "active", taskDirName);
  await fse.ensureDir(taskDir);

  await fse.writeFile(
    path.join(taskDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await fse.writeFile(path.join(taskDir, "spec.md"), `Spec for ${manifest.id}\n`, "utf8");
}

// =============================================================================
// TESTS
// =============================================================================

describe("tasks import-run", () => {
  it("imports completed tasks and skips ineligible entries", async () => {
    const homeDir = makeTemporaryDirectory("tasks-cli-home-");
    process.env.MYCELIUM_HOME = homeDir;

    const repoPath = makeTemporaryDirectory("tasks-cli-repo-");
    const config = makeProjectConfig(repoPath);
    const tasksRoot = path.join(repoPath, ".mycelium", "tasks");

    const manifestA: TaskManifest = {
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
    };
    const manifestB: TaskManifest = {
      id: "102",
      name: "Beta Task",
      description: "Beta description",
      estimated_minutes: 10,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    await writeTaskSpec(tasksRoot, manifestA);
    await writeTaskSpec(tasksRoot, manifestB);

    const projectName = "demo-project";
    const runId = "run-101";
    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: ["101", "102"],
    });

    state.status = "complete";
    state.batches = [
      {
        batch_id: 1,
        status: "complete",
        tasks: ["101"],
        started_at: "2024-03-01T00:00:00.000Z",
        completed_at: "2024-03-01T00:05:00.000Z",
        merge_commit: "deadbeef",
        integration_doctor_passed: true,
      },
      {
        batch_id: 2,
        status: "complete",
        tasks: ["102"],
        started_at: "2024-03-01T00:06:00.000Z",
        completed_at: "2024-03-01T00:10:00.000Z",
        integration_doctor_passed: true,
      },
    ];

    state.tasks["101"].status = "complete";
    state.tasks["101"].batch_id = 1;
    state.tasks["101"].completed_at = "2024-03-01T00:05:00.000Z";
    state.tasks["102"].status = "complete";
    state.tasks["102"].batch_id = 2;
    state.tasks["102"].completed_at = "2024-03-01T00:10:00.000Z";

    const store = new StateStore(projectName, runId);
    await store.save(state);

    await tasksImportRunCommand(projectName, config, { runId });

    const ledger = await loadTaskLedger(projectName);
    expect(ledger?.tasks["101"]).toBeDefined();
    expect(ledger?.tasks["102"]).toBeUndefined();
  });
});

describe("tasks set-status", () => {
  it("updates task state and clears review metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-02T00:00:00Z"));

    const homeDir = makeTemporaryDirectory("tasks-cli-home-");
    process.env.MYCELIUM_HOME = homeDir;

    const repoPath = makeTemporaryDirectory("tasks-cli-repo-");
    const config = makeProjectConfig(repoPath);

    const projectName = "demo-project";
    const runId = "run-202";
    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: ["201"],
    });

    state.tasks["201"].status = "failed";
    state.tasks["201"].completed_at = "2024-03-01T00:00:00.000Z";
    state.tasks["201"].last_error = "failed task";
    state.tasks["201"].human_review = {
      validator: "test",
      reason: "needs review",
      summary: "summary",
    };

    const store = new StateStore(projectName, runId);
    await store.save(state);

    await tasksSetStatusCommand(projectName, config, {
      runId,
      taskId: "201",
      status: "complete",
      force: false,
    });

    const updated = await store.load();
    expect(updated.tasks["201"].status).toBe("complete");
    expect(updated.tasks["201"].completed_at).toBe("2024-03-02T00:00:00.000Z");
    expect(updated.tasks["201"].last_error).toBeUndefined();
    expect(updated.tasks["201"].human_review).toBeUndefined();
  });
});
