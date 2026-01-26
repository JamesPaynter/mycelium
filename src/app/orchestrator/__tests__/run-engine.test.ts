/**
 * RunEngine unit tests with deterministic fakes.
 * Purpose: validate run semantics without Docker or real git workspaces.
 * Assumptions: core workspaces + git changes are mocked.
 * Usage: npm test -- src/app/orchestrator/__tests__/run-engine.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectConfigSchema, type ProjectConfig } from "../../../core/config.js";
import {
  createPathsContext,
  runSummaryReportPath,
  type PathsContext,
} from "../../../core/paths.js";
import { StateStore } from "../../../core/state-store.js";
import { createRunState, startBatch } from "../../../core/state.js";
import { buildTaskDirName, type TaskManifest } from "../../../core/task-manifest.js";
import type { listChangedFiles } from "../../../git/changes.js";
import type { OrchestratorPorts, ValidatorRunner } from "../ports.js";
import { runEngine, type RunOptions, type RunResult } from "../run/run-engine.js";
import { buildRunContext } from "../run-context-builder.js";
import type { RunContext } from "../run-context.js";
import type {
  WorkerCleanupInput,
  WorkerPrepareInput,
  WorkerResumeAttemptInput,
  WorkerRunAttemptInput,
  WorkerRunner,
  WorkerRunnerResult,
  WorkerStopInput,
  WorkerStopResult,
} from "../workers/worker-runner.js";

import { FakeClock, FakeLogSink, FakeStateRepository, FakeVcs, FakeWorkerRunner } from "./fakes.js";

const workerRunnerMocks = vi.hoisted(() => {
  let activeRunner: WorkerRunner | null = null;

  return {
    setRunner(runner: WorkerRunner) {
      activeRunner = runner;
    },
    clearRunner() {
      activeRunner = null;
    },
    getRunner(): WorkerRunner {
      if (!activeRunner) {
        throw new Error("FakeWorkerRunner not set for this test.");
      }
      return activeRunner;
    },
  };
});

const changesMocks = vi.hoisted(() => {
  const listChangedFilesMock = vi.fn<typeof listChangedFiles>();
  return { listChangedFilesMock };
});

vi.mock("../workers/local-worker-runner.js", () => {
  class LocalWorkerRunner {
    async prepare(input: WorkerPrepareInput): Promise<void> {
      await workerRunnerMocks.getRunner().prepare(input);
    }

    async runAttempt(input: WorkerRunAttemptInput): Promise<WorkerRunnerResult> {
      return workerRunnerMocks.getRunner().runAttempt(input);
    }

    async resumeAttempt(input: WorkerResumeAttemptInput): Promise<WorkerRunnerResult> {
      return workerRunnerMocks.getRunner().resumeAttempt(input);
    }

    async stop(input: WorkerStopInput): Promise<WorkerStopResult | null> {
      return workerRunnerMocks.getRunner().stop(input);
    }

    async cleanupTask(input: WorkerCleanupInput): Promise<void> {
      await workerRunnerMocks.getRunner().cleanupTask(input);
    }
  }

  return { LocalWorkerRunner };
});

vi.mock("../../../core/workspaces.js", async () => {
  const actual = await vi.importActual<typeof import("../../../core/workspaces.js")>(
    "../../../core/workspaces.js",
  );
  const { taskWorkspaceDir } =
    await vi.importActual<typeof import("../../../core/paths.js")>("../../../core/paths.js");
  const { ensureDir } =
    await vi.importActual<typeof import("../../../core/utils.js")>("../../../core/utils.js");

  return {
    ...actual,
    prepareTaskWorkspace: async (opts: {
      projectName: string;
      runId: string;
      taskId: string;
      paths?: PathsContext;
    }) => {
      const workspacePath = taskWorkspaceDir(opts.projectName, opts.runId, opts.taskId, opts.paths);
      await ensureDir(workspacePath);
      return { workspacePath, created: true };
    },
    removeTaskWorkspace: async () => undefined,
    removeRunWorkspace: async () => undefined,
  };
});

vi.mock("../../../git/changes.js", () => ({
  listChangedFiles: (...args: Parameters<typeof listChangedFiles>) =>
    changesMocks.listChangedFilesMock(...args),
}));

// =============================================================================
// TEST SETUP
// =============================================================================

const temporaryDirectories: string[] = [];

beforeEach(() => {
  changesMocks.listChangedFilesMock.mockReset();
  changesMocks.listChangedFilesMock.mockResolvedValue([]);
});

afterEach(async () => {
  for (const directoryPath of temporaryDirectories) {
    await fs.rm(directoryPath, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;

  workerRunnerMocks.clearRunner();
});

// =============================================================================
// HELPERS
// =============================================================================

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}

async function setupRepo(prefix: string): Promise<{
  repoPath: string;
  tasksRoot: string;
  tmpRoot: string;
  paths: PathsContext;
}> {
  const tmpRoot = await makeTemporaryDirectory(prefix);
  const repoPath = path.join(tmpRoot, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  const tasksRoot = path.join(repoPath, "tasks");
  await fs.mkdir(tasksRoot, { recursive: true });
  const paths = createPathsContext({ myceliumHome: path.join(tmpRoot, "mycelium-home") });

  return { repoPath, tasksRoot, tmpRoot, paths };
}

function buildProjectConfig(
  repoPath: string,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return ProjectConfigSchema.parse({
    repo_path: repoPath,
    main_branch: "main",
    tasks_dir: "tasks",
    doctor: "true",
    resources: [{ name: "repo", paths: ["**/*"] }],
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock" },
    ...overrides,
  });
}

function buildTaskManifest(
  id: string,
  name: string,
  overrides: Partial<TaskManifest> = {},
): TaskManifest {
  const base: TaskManifest = {
    id,
    name,
    description: `Task ${id} for run-engine tests.`,
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: ["repo"] },
    files: { reads: [], writes: [`src/${id}.txt`] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "true" },
  };

  return {
    ...base,
    ...overrides,
    dependencies: overrides.dependencies ?? base.dependencies,
    locks: { ...base.locks, ...(overrides.locks ?? {}) },
    files: { ...base.files, ...(overrides.files ?? {}) },
    verify: { ...base.verify, ...(overrides.verify ?? {}) },
  };
}

async function writeTaskSpec(tasksRoot: string, manifest: TaskManifest): Promise<void> {
  const taskDirName = buildTaskDirName({ id: manifest.id, name: manifest.name });
  const taskDir = path.join(tasksRoot, taskDirName);
  await fs.mkdir(taskDir, { recursive: true });

  await fs.writeFile(
    path.join(taskDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(taskDir, "spec.md"), `# ${manifest.name}\n`, "utf8");
}

function buildValidatorRunner(): ValidatorRunner {
  return {
    runDoctorValidator: async () => null,
    runTestValidator: async () => null,
    runStyleValidator: async () => null,
    runArchitectureValidator: async () => null,
  };
}

function buildPortOverrides(input: {
  logsRoot: string;
  vcs: FakeVcs;
  paths: PathsContext;
}): Partial<OrchestratorPorts> {
  return {
    vcs: input.vcs,
    stateRepository: new FakeStateRepository(input.paths),
    logSink: new FakeLogSink(input.logsRoot),
    clock: new FakeClock(),
    validatorRunner: buildValidatorRunner(),
  };
}

async function buildTestContext(input: {
  projectName: string;
  config: ProjectConfig;
  options: RunOptions;
  ports: Partial<OrchestratorPorts>;
  paths: PathsContext;
}): Promise<RunContext<RunOptions, RunResult>> {
  return buildRunContext({
    projectName: input.projectName,
    config: input.config,
    options: input.options,
    paths: input.paths,
    ports: input.ports,
    legacy: {
      runProject: async () => {
        throw new Error("Legacy run engine should not be invoked in unit tests.");
      },
    },
  });
}

function useFakeRunner(runner: WorkerRunner): void {
  workerRunnerMocks.setRunner(runner);
}

// =============================================================================
// TESTS
// =============================================================================

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

    const result = await runEngine(context);

    expect(result.state.status).toBe("complete");
    expect(result.state.tasks["001"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.attempts).toBe(2);
    expect(fakeRunner.runCalls).toHaveLength(3);
    expect(fakeVcs.mergeCalls).toHaveLength(2);
  });

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

    const result = await runEngine(context);

    expect(result.state.status).toBe("complete");
    expect(result.state.tasks["001"]?.status).toBe("complete");
    expect(result.state.tasks["002"]?.status).toBe("complete");
    expect(fakeRunner.runCalls).toHaveLength(1);
    expect(fakeRunner.runCalls[0]?.taskId).toBe("002");
  });

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

    changesMocks.listChangedFilesMock.mockResolvedValue(["src/blocked.txt"]);

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
