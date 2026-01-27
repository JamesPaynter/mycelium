import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runSummaryReportPath } from "../../../core/paths.js";

import { FakeVcs, FakeWorkerRunner } from "./fakes.js";
import {
  buildPortOverrides,
  buildProjectConfig,
  buildTaskManifest,
  buildTestContext,
  getChangesMocks,
  loadRunEngine,
  registerRunEngineTestHooks,
  setupRepo,
  useFakeRunner,
  writeTaskSpec,
} from "./run-engine.test-kit.js";

registerRunEngineTestHooks();

describe("runEngine", () => {
  it("returns a stopped result when the stop signal is already set", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-stop-");

    await writeTaskSpec(tasksRoot, buildTaskManifest("001", "stop-task"));

    const config = buildProjectConfig(repoPath);
    const projectName = "stop-run";
    const runId = "run-stop";

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.setStopResult({ stopped: 1, errors: 0 });
    useFakeRunner(fakeRunner);

    const controller = new AbortController();
    controller.abort("stop-now");

    const fakeVcs = new FakeVcs();
    const context = await buildTestContext({
      projectName,
      config,
      options: {
        runId,
        useDocker: false,
        buildImage: false,
        stopSignal: controller.signal,
        stopContainersOnExit: true,
        reuseCompleted: false,
      },
      ports: buildPortOverrides({ logsRoot: path.join(tmpRoot, "log-sink"), vcs: fakeVcs, paths }),
      paths,
    });

    const { runEngine } = await loadRunEngine();
    const result = await runEngine(context);

    expect(result.stopped?.containers).toBe("stopped");
    expect(result.stopped?.stopContainersRequested).toBe(true);
    expect(fakeRunner.stopCalls).toHaveLength(1);
  });

  it("fails the run when budget enforcement blocks", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-budget-");

    await writeTaskSpec(tasksRoot, buildTaskManifest("001", "budget-task"));

    const config = buildProjectConfig(repoPath, {
      budgets: { max_tokens_per_task: 1, mode: "block" },
    });
    const projectName = "budget-run";
    const runId = "run-budget";

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueRunAttempt("001", { success: true }, { tokens: 10, attempt: 1 });
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

    expect(result.state.status).toBe("failed");
    expect(result.state.tasks["001"]?.status).toBe("validated");
  });

  it("rescopes and retries tasks when manifest enforcement blocks", async () => {
    const { repoPath, tasksRoot, tmpRoot, paths } = await setupRepo("run-engine-compliance-");

    await writeTaskSpec(
      tasksRoot,
      buildTaskManifest("001", "compliance-task", {
        locks: { reads: [], writes: [] },
        files: { reads: [], writes: [] },
      }),
    );

    getChangesMocks().listChangedFilesMock.mockResolvedValue(["src/blocked.txt"]);

    const config = buildProjectConfig(repoPath, {
      manifest_enforcement: "block",
    });
    const projectName = "compliance-run";
    const runId = "run-compliance";

    const fakeRunner = new FakeWorkerRunner();
    fakeRunner.queueRunAttempt("001", { success: true });
    fakeRunner.queueRunAttempt("001", { success: true });
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
    expect(result.state.tasks["001"]?.attempts).toBe(2);

    const summaryPath = runSummaryReportPath(repoPath, runId);
    const summaryRaw = await fs.readFile(summaryPath, "utf8");
    const summary = JSON.parse(summaryRaw) as {
      metrics?: { scope_violations?: { block_count?: number } };
    };
    expect(summary.metrics?.scope_violations?.block_count).toBe(1);
  });
});
