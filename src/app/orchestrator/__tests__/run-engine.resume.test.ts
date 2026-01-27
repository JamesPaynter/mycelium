import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../../../core/state-store.js";
import { createRunState, startBatch } from "../../../core/state.js";

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
  it("retries a running task after reset-to-pending on resume", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-retry-");

    await writeTaskSpec(tasksRoot, buildTaskManifest("001", "retry-task"));

    const config = buildProjectConfig(repoPath);
    const projectName = "retry-run";
    const runId = "run-retry";

    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: ["001"],
    });
    startBatch(state, {
      batchId: 1,
      taskIds: ["001"],
      locks: { reads: [], writes: ["repo"] },
    });
    const store = new StateStore(projectName, runId, paths);
    await store.save(state);

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueResumeAttempt("001", {
      success: false,
      resetToPending: true,
      errorMessage: "lost container",
    });
    fakeRunner.queueRunAttempt("001", { success: true });
    useFakeRunner(fakeRunner);

    const fakeVcs = new FakeVcs();
    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        resume: true,
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
    expect(result.state.tasks["001"]?.attempts).toBe(2);
    expect(fakeRunner.resumeCalls).toHaveLength(1);
    expect(fakeRunner.runCalls).toHaveLength(1);
  });

  it("resumes a paused run and only executes pending tasks", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-resume-");

    await writeTaskSpec(tasksRoot, buildTaskManifest("001", "already-done"));
    await writeTaskSpec(tasksRoot, buildTaskManifest("002", "still-pending"));

    const config = buildProjectConfig(repoPath);
    const projectName = "resume-run";
    const runId = "run-resume";

    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: ["001", "002"],
    });
    state.status = "paused";
    state.tasks["001"].status = "complete";
    state.tasks["001"].attempts = 1;
    state.tasks["001"].completed_at = "2024-01-01T00:00:00.000Z";

    const store = new StateStore(projectName, runId, paths);
    await store.save(state);

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueRunAttempt("002", { success: true });
    useFakeRunner(fakeRunner);

    const fakeVcs = new FakeVcs();
    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        resume: true,
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
    expect(fakeRunner.runCalls).toHaveLength(1);
    expect(fakeRunner.runCalls[0]?.taskId).toBe("002");
  });
});
