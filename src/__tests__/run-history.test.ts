import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHistoryIndexPath } from "../core/paths.js";
import { listRunHistoryEntries } from "../core/run-history.js";
import { createRunState } from "../core/state.js";
import { StateStore } from "../core/state-store.js";

const originalHome = process.env.MYCELIUM_HOME;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;

  if (originalHome === undefined) {
    delete process.env.MYCELIUM_HOME;
  } else {
    process.env.MYCELIUM_HOME = originalHome;
  }
});

// =============================================================================
// HELPERS
// =============================================================================

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-history-"));
  tempDirs.push(dir);
  return dir;
}

function writeRunStateFile(
  root: string,
  projectName: string,
  runId: string,
  taskIds: string[],
): void {
  const stateDir = path.join(root, "state", projectName);
  fs.mkdirSync(stateDir, { recursive: true });

  const state = createRunState({
    runId,
    project: projectName,
    repoPath: "/repo",
    mainBranch: "main",
    taskIds,
  });

  const statePath = path.join(stateDir, `run-${runId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

// =============================================================================
// TESTS
// =============================================================================

describe("run history", () => {
  it("records run history on state save", async () => {
    const home = makeTempHome();
    process.env.MYCELIUM_HOME = home;

    const project = "demo-project";
    const runId = "run-001";
    const store = new StateStore(project, runId);
    const state = createRunState({
      runId,
      project,
      repoPath: "/repo",
      mainBranch: "main",
      taskIds: ["001", "002"],
    });

    await store.save(state);

    const indexPath = runHistoryIndexPath(project);
    expect(fs.existsSync(indexPath)).toBe(true);

    const runs = await listRunHistoryEntries(project);
    expect(runs.map((entry) => entry.runId)).toContain(runId);
    expect(runs.find((entry) => entry.runId === runId)?.taskCount).toBe(2);
  });

  it("backfills run history from state files when index is missing", async () => {
    const home = makeTempHome();
    process.env.MYCELIUM_HOME = home;

    const project = "demo-project";
    const runId = "run-002";

    writeRunStateFile(home, project, runId, ["alpha"]);

    const runs = await listRunHistoryEntries(project);
    expect(runs.map((entry) => entry.runId)).toContain(runId);

    const indexPath = runHistoryIndexPath(project);
    expect(fs.existsSync(indexPath)).toBe(true);
  });
});
