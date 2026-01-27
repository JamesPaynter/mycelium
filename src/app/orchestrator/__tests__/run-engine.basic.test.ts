import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeVcs, FakeWorkerRunner } from "./fakes.js";
import {
  buildPortOverrides,
  buildProjectConfig,
  buildTaskManifest,
  buildTestContext,
  loadRunEngine,
  registerRunEngineTestHooks,
  setupRepo,
  useFakeRunner,
  writeTaskSpec,
} from "./run-engine.test-kit.js";

registerRunEngineTestHooks();

describe("runEngine", () => {
  it("uses explicit crashAfterContainerStart options", async () => {
    const { repoPath, tmpRoot, paths } = await setupRepo("run-engine-crash-");
    const config = buildProjectConfig(repoPath);
    const projectName = "crash-run";
    const runId = "run-crash";

    const fakeVcs = new FakeVcs();
    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
        reuseCompleted: false,
        crashAfterContainerStart: true,
      },
      ports: buildPortOverrides({ logsRoot: path.join(tmpRoot, "log-sink"), vcs: fakeVcs, paths }),
      paths,
    });

    expect(context.resolved.flags.crashAfterContainerStart).toBe(true);
  });

  it("runs tasks to completion with sequential batches", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-basic-");

    await writeTaskSpec(tasksRoot, buildTaskManifest("001", "alpha"));
    await writeTaskSpec(tasksRoot, buildTaskManifest("002", "beta"));

    const config = buildProjectConfig(repoPath);
    const projectName = "basic-run";
    const runId = "run-basic";

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueRunAttempt("001", { success: true });
    fakeRunner.queueRunAttempt("002", { success: true });
    useFakeRunner(fakeRunner);

    const fakeVcs = new FakeVcs();
    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
        reuseCompleted: false,
      },
      ports: buildPortOverrides({ logsRoot: path.join(tmpRoot, "log-sink"), vcs: fakeVcs, paths }),
      paths,
    });

    const { runEngine } = await loadRunEngine();
    const result = await runEngine(context);

    expect(result.state.status).toBe("complete");
    expect(result.state.tasks["001"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.status).toBe("complete");
    expect(result.plan).toHaveLength(2);
    expect(fakeRunner.runCalls).toHaveLength(2);
  });

  it("reschedules merge conflicts without failing the run", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-merge-");

    await writeTaskSpec(
      tasksRoot,
      buildTaskManifest("001", "alpha", { locks: { reads: [], writes: [] } }),
    );
    await writeTaskSpec(
      tasksRoot,
      buildTaskManifest("002", "beta", { locks: { reads: [], writes: [] } }),
    );

    const config = buildProjectConfig(repoPath);
    const projectName = "merge-conflict-run";
    const runId = "run-merge-conflict";

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueRunAttempt("001", { success: true });
    fakeRunner.queueRunAttempt("002", { success: true });
    fakeRunner.queueRunAttempt("002", { success: true });
    useFakeRunner(fakeRunner);

    const fakeVcs = new FakeVcs();
    const branchA = fakeVcs.buildTaskBranchName("001", "alpha");
    const branchB = fakeVcs.buildTaskBranchName("002", "beta");
    const workspaceA = path.join(tmpRoot, "workspace-001");
    const workspaceB = path.join(tmpRoot, "workspace-002");

    fakeVcs.queueMergeResult({
      status: "merged",
      merged: [{ taskId: "001", branchName: branchA, workspacePath: workspaceA }],
      conflicts: [
        {
          branch: { taskId: "002", branchName: branchB, workspacePath: workspaceB },
          message: "merge conflict",
        },
      ],
      mergeCommit: "merge-sha-1",
    });
    fakeVcs.queueMergeResult({
      status: "merged",
      merged: [{ taskId: "002", branchName: branchB, workspacePath: workspaceB }],
      conflicts: [],
      mergeCommit: "merge-sha-2",
    });

    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        maxParallel: 2,
        useDocker: false,
        buildImage: false,
        reuseCompleted: false,
      },
      ports: buildPortOverrides({ logsRoot: path.join(tmpRoot, "log-sink"), vcs: fakeVcs, paths }),
      paths,
    });

    const { runEngine } = await loadRunEngine();
    const result = await runEngine(context);

    expect(result.state.status).toBe("complete");
    expect(result.state.tasks["001"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.attempts).toBe(2);
    expect(fakeRunner.runCalls).toHaveLength(3);
    expect(fakeVcs.tempMergeCalls).toHaveLength(2);
  });
});
