import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import { ProjectConfigSchema, type ProjectConfig } from "../../../core/config.js";
import { createPathsContext, type PathsContext } from "../../../core/paths.js";
import { buildTaskDirName, type TaskManifest } from "../../../core/task-manifest.js";
import type { listChangedFiles } from "../../../git/changes.js";
import type { OrchestratorPorts, ValidatorRunner } from "../ports.js";
import type { RunOptions, RunResult } from "../run/run-engine.js";
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

import { FakeClock, FakeLogSink, FakeStateRepository } from "./fakes.js";

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

export function getChangesMocks(): { listChangedFilesMock: ReturnType<typeof vi.fn> } {
  return changesMocks;
}

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

export function registerRunEngineTestHooks(): void {
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
}

// =============================================================================
// HELPERS
// =============================================================================

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}

export async function setupRepo(prefix: string): Promise<{
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

export function buildProjectConfig(
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

export function buildTaskManifest(
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

export async function writeTaskSpec(tasksRoot: string, manifest: TaskManifest): Promise<void> {
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

export function buildPortOverrides(input: {
  logsRoot: string;
  vcs: OrchestratorPorts["vcs"];
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

export async function buildTestContext(input: {
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

export function useFakeRunner(runner: WorkerRunner): void {
  workerRunnerMocks.setRunner(runner);
}

export async function loadRunEngine(): Promise<typeof import("../run/run-engine.js")> {
  return import("../run/run-engine.js");
}
