import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunContainerSummary } from "../docker/manager.js";

import { buildCleanupPlan, executeCleanupPlan } from "./cleanup.js";
import { createPathsContext, runLogsDir, runStatePath, runWorkspaceDir } from "./paths.js";
import type { PathsContext } from "./paths.js";

describe("cleanup", () => {
  const projectName = "demo-project";
  let tmpHome: string;
  let paths: PathsContext;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
    paths = createPathsContext({ myceliumHome: tmpHome });
  });

  afterEach(async () => {
    await fse.remove(tmpHome);
  });

  it("builds a cleanup plan for existing run artifacts", async () => {
    const runId = "20260110-120000";

    const workspace = runWorkspaceDir(projectName, runId, paths);
    const logs = runLogsDir(projectName, runId, paths);
    const stateFile = runStatePath(projectName, runId, paths);

    await fse.ensureDir(workspace);
    await fse.ensureDir(logs);
    await fse.ensureDir(path.dirname(stateFile));
    await fse.writeFile(stateFile, "{}");

    const fakeDocker = new FakeDockerManager([
      { id: "abc", name: "ct-1", state: "exited", status: "Exited (0)" },
    ]);

    const plan = await buildCleanupPlan(projectName, {
      removeContainers: true,
      dockerManager: fakeDocker,
      paths,
    });

    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.runId).toBe(runId);
    expect(plan.targets.map((t) => t.kind).sort()).toEqual(["logs", "state", "workspace"]);
    expect(plan.containers).toHaveLength(1);
    expect(plan.containers[0]?.id).toBe("abc");
  });

  it("respects keepLogs and removes artifacts with container cleanup", async () => {
    const runId = "20260110-130000";

    const workspace = runWorkspaceDir(projectName, runId, paths);
    const logs = runLogsDir(projectName, runId, paths);
    const stateFile = runStatePath(projectName, runId, paths);

    await fse.ensureDir(workspace);
    await fse.ensureDir(logs);
    await fse.ensureDir(path.dirname(stateFile));
    await fse.writeFile(stateFile, "{}");

    const fakeDocker = new FakeDockerManager([
      { id: "xyz", name: "ct-2", state: "running", status: "Up" },
    ]);

    const plan = await buildCleanupPlan(projectName, {
      runId,
      keepLogs: true,
      removeContainers: true,
      dockerManager: fakeDocker,
      paths,
    });

    expect(plan).not.toBeNull();
    if (!plan) return;

    const messages: string[] = [];
    await executeCleanupPlan(plan, {
      dryRun: true,
      log: (m) => messages.push(m),
      dockerManager: fakeDocker,
    });

    expect(await fse.pathExists(workspace)).toBe(true);
    expect(await fse.pathExists(logs)).toBe(true);
    expect(await fse.pathExists(stateFile)).toBe(true);
    expect(messages.some((m) => m.includes("Would remove workspace"))).toBe(true);
    expect(fakeDocker.removed).toHaveLength(0);

    messages.length = 0;
    await executeCleanupPlan(plan, { log: (m) => messages.push(m), dockerManager: fakeDocker });

    expect(await fse.pathExists(workspace)).toBe(false);
    expect(await fse.pathExists(logs)).toBe(true); // keepLogs true
    expect(await fse.pathExists(stateFile)).toBe(false);
    expect(fakeDocker.removed.map((c) => c.id)).toEqual(["xyz"]);
    expect(messages.some((m) => m.includes("Removed workspace"))).toBe(true);
  });

  it("rejects cleanup targets outside the configured roots", async () => {
    const maliciousRunId = "../../../../evil";
    const workspace = runWorkspaceDir(projectName, maliciousRunId, paths);
    await fse.ensureDir(workspace);

    await expect(
      buildCleanupPlan(projectName, { runId: maliciousRunId, removeContainers: false, paths }),
    ).rejects.toThrow(/outside/i);
  });
});

class FakeDockerManager {
  removed: RunContainerSummary[] = [];

  constructor(private readonly containers: RunContainerSummary[]) {}

  async listRunContainers(_projectName: string, _runId: string): Promise<RunContainerSummary[]> {
    return this.containers;
  }

  async removeContainers(containers: RunContainerSummary[]): Promise<void> {
    this.removed.push(...containers);
  }
}
