import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../app/context.js";
import { ProjectConfigSchema, type ProjectConfig } from "../core/config.js";
import { createPathsContext } from "../core/paths.js";
import { StateStore } from "../core/state-store.js";
import { createRunState } from "../core/state.js";

import { runCommand } from "./run.js";

const runProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../core/executor.js", () => ({
  runProject: (...args: unknown[]) => runProjectMock(...args),
}));

vi.mock("./signal-handlers.js", () => ({
  createRunStopSignalHandler: () => {
    const controller = new AbortController();
    return {
      signal: controller.signal,
      cleanup: () => undefined,
      isStopped: () => false,
    };
  },
}));

vi.mock("./ui.js", () => ({
  launchUiServer: async () => null,
  closeUiServer: async () => undefined,
  maybeOpenUiBrowser: async () => undefined,
  resolveUiRuntimeConfig: () => ({ enabled: false, port: 0, openBrowser: false }),
}));

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

  runProjectMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// =============================================================================
// HELPERS
// =============================================================================

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(repoPath: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    repo_path: repoPath,
    main_branch: "main",
    tasks_dir: "tasks",
    doctor: "true",
    resources: [{ name: "repo", paths: ["**/*"] }],
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock" },
  });
}

function buildRunResult(project: string, repoPath: string, runId: string) {
  return {
    runId,
    state: createRunState({
      runId,
      project,
      repoPath,
      mainBranch: "main",
      taskIds: [],
    }),
    plan: [],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("run command auto-resume", () => {
  it("resumes the latest paused run when no run-id is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T00:00:00Z"));

    const home = makeTempDir("run-cli-home-");
    const repoPath = makeTempDir("run-cli-repo-");
    process.env.MYCELIUM_HOME = home;

    const config = makeConfig(repoPath);
    const projectName = "demo-project";
    const paths = createPathsContext({ myceliumHome: home });

    const firstState = createRunState({
      runId: "run-001",
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: [],
    });
    firstState.status = "paused";
    await new StateStore(projectName, "run-001", paths).save(firstState);

    vi.setSystemTime(new Date("2024-06-01T00:10:00Z"));
    const secondState = createRunState({
      runId: "run-002",
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: [],
    });
    secondState.status = "paused";
    await new StateStore(projectName, "run-002", paths).save(secondState);

    runProjectMock.mockResolvedValue(buildRunResult(projectName, repoPath, "run-002"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCommand(projectName, config, { maxParallel: 1, useDocker: false, buildImage: false }, {
      paths,
    } as AppContext);

    const call = runProjectMock.mock.calls[0] ?? [];
    expect(call[0]).toBe(projectName);
    expect(call[1]).toBe(config);
    expect(call[2]).toEqual(expect.objectContaining({ runId: "run-002", resume: true }));
    expect(call[3]).toBe(paths);

    const output = logSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Resuming paused run run-002");
  });

  it("resumes a specified paused run-id", async () => {
    const home = makeTempDir("run-cli-home-");
    const repoPath = makeTempDir("run-cli-repo-");
    process.env.MYCELIUM_HOME = home;

    const config = makeConfig(repoPath);
    const projectName = "demo-project";
    const runId = "run-paused";
    const paths = createPathsContext({ myceliumHome: home });

    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: [],
    });
    state.status = "paused";
    await new StateStore(projectName, runId, paths).save(state);

    runProjectMock.mockResolvedValue(buildRunResult(projectName, repoPath, runId));

    await runCommand(
      projectName,
      config,
      { runId, maxParallel: 1, useDocker: false, buildImage: false },
      { paths } as AppContext,
    );

    const call = runProjectMock.mock.calls[0] ?? [];
    expect(call[0]).toBe(projectName);
    expect(call[1]).toBe(config);
    expect(call[2]).toEqual(expect.objectContaining({ runId, resume: true }));
  });

  it("leaves non-paused runs unchanged when a run-id is provided", async () => {
    const home = makeTempDir("run-cli-home-");
    const repoPath = makeTempDir("run-cli-repo-");
    process.env.MYCELIUM_HOME = home;

    const config = makeConfig(repoPath);
    const projectName = "demo-project";
    const runId = "run-complete";
    const paths = createPathsContext({ myceliumHome: home });

    const state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: "main",
      taskIds: [],
    });
    state.status = "complete";
    await new StateStore(projectName, runId, paths).save(state);

    runProjectMock.mockResolvedValue(buildRunResult(projectName, repoPath, runId));

    await runCommand(
      projectName,
      config,
      { runId, maxParallel: 1, useDocker: false, buildImage: false },
      { paths } as AppContext,
    );

    const call = runProjectMock.mock.calls[0] ?? [];
    const options = call[2] as { resume?: boolean };
    expect(options?.resume).not.toBe(true);
  });
});
