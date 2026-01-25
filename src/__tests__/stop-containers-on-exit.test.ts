import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listContainersMock = vi.fn();
  const getContainerMock = vi.fn();
  const removeContainerMock = vi.fn(async () => undefined);
  const imageExistsMock = vi.fn(async () => true);
  const dockerClientMock = vi.fn(() => ({
    listContainers: listContainersMock,
    getContainer: getContainerMock,
  }));

  return {
    listContainersMock,
    getContainerMock,
    removeContainerMock,
    imageExistsMock,
    dockerClientMock,
  };
});

vi.mock("../docker/docker.js", () => {
  return {
    DEFAULT_CPU_PERIOD: 100000,
    dockerClient: mocks.dockerClientMock,
    imageExists: mocks.imageExistsMock,
    removeContainer: mocks.removeContainerMock,
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    waitContainer: vi.fn(),
    findContainerByName: vi.fn(),
  };
});

import { runProject } from "../core/executor.js";
import { orchestratorLogPath, runStatePath } from "../core/paths.js";

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("executor: --stop-containers-on-exit", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const dir of tempRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempRoots.length = 0;

    for (const key of ENV_VARS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it("leaves containers running by default when a stop signal occurs", async () => {
    const { repoDir } = await makeRepoWithSingleTask();

    const projectName = "stop-containers-default";
    const runId = `run-${Date.now()}`;

    seedDockerContainers({ projectName, runId, taskIds: ["001", "002"] });

    const controller = new AbortController();
    controller.abort({ signal: "SIGINT" });

    const res = await runProject(projectName, makeMinimalConfig(repoDir), {
      runId,
      useDocker: true,
      buildImage: false,
      stopContainersOnExit: false,
      stopSignal: controller.signal,
    });

    expect(res.stopped?.containers).toBe("left_running");
    expect(mocks.listContainersMock).not.toHaveBeenCalled();
    expect(mocks.removeContainerMock).not.toHaveBeenCalled();

    const stateFile = runStatePath(projectName, runId);
    const logFile = orchestratorLogPath(projectName, runId);
    expect(await fileExists(stateFile)).toBe(true);
    expect(await fileExists(logFile)).toBe(true);

    const events = await readLogTypes(logFile);
    expect(events).toContain("run.stop");
  });

  it("stops and removes matching run containers when requested", async () => {
    const { repoDir } = await makeRepoWithSingleTask();

    const projectName = "stop-containers-requested";
    const runId = `run-${Date.now()}`;

    seedDockerContainers({ projectName, runId, taskIds: ["001", "002"] });

    mocks.getContainerMock.mockImplementation((id: string) => {
      return { id, stop: vi.fn(async () => undefined) };
    });

    const controller = new AbortController();
    controller.abort({ signal: "SIGTERM" });

    const res = await runProject(projectName, makeMinimalConfig(repoDir), {
      runId,
      useDocker: true,
      buildImage: false,
      stopContainersOnExit: true,
      stopSignal: controller.signal,
    });

    expect(res.stopped?.containers).toBe("stopped");
    expect(mocks.listContainersMock).toHaveBeenCalledTimes(1);
    expect(mocks.removeContainerMock).toHaveBeenCalledTimes(2);

    const logFile = orchestratorLogPath(projectName, runId);
    const events = await readLogTypes(logFile);
    expect(events).toContain("container.stop");
    expect(events).toContain("run.stop");

    const lines = await fs.readFile(logFile, "utf8");
    expect(lines).toMatch(/"containers_stopped":2/);
  });

  async function makeRepoWithSingleTask(): Promise<{ repoDir: string }> {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-stop-containers-"));
    tempRoots.push(tmpRoot);

    const repoDir = path.join(tmpRoot, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    await execa("git", ["init"], { cwd: repoDir });
    await execa("git", ["config", "user.email", "stop@example.com"], { cwd: repoDir });
    await execa("git", ["config", "user.name", "Stop Test"], { cwd: repoDir });

    await fs.writeFile(path.join(repoDir, "README.md"), "# Repo\n", "utf8");

    const taskDir = path.join(repoDir, ".mycelium", "tasks", "001-stop");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, "manifest.json"),
      JSON.stringify(
        {
          id: "001",
          name: "Stop",
          description: "Stop test task",
          estimated_minutes: 1,
          locks: { reads: [], writes: [] },
          files: { reads: [], writes: [] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "bash -c 'exit 0'" },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(taskDir, "spec.md"), "# Spec\n", "utf8");

    await execa("git", ["add", "-A"], { cwd: repoDir });
    await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
    await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });

    const homeDir = path.join(tmpRoot, ".mycelium-home");
    process.env.MYCELIUM_HOME = homeDir;
    process.env.MOCK_LLM = "1";

    return { repoDir };
  }
});

function makeMinimalConfig(repoDir: string): any {
  return {
    repo_path: repoDir,
    main_branch: "main",
    task_branch_prefix: "agent/",
    tasks_dir: ".mycelium/tasks",
    planning_dir: ".mycelium/planning",
    max_parallel: 1,
    max_retries: 1,
    doctor: "bash -c 'exit 0'",
    bootstrap: [],
    test_paths: ["**/*"],
    resources: [{ name: "repo", paths: ["**/*"] }],
    docker: {
      image: "mycelium-worker:latest",
      dockerfile: "templates/Dockerfile",
      build_context: ".",
      user: "worker",
      network_mode: "bridge",
    },
    manifest_enforcement: "warn",
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock", checkpoint_commits: true },
    budgets: { mode: "warn" },
  };
}

function seedDockerContainers(args: {
  projectName: string;
  runId: string;
  taskIds: string[];
}): void {
  const { projectName, runId, taskIds } = args;

  const containers = taskIds.map((taskId) => {
    return {
      Id: `mock-${taskId}`,
      Names: [`/mycelium-${taskId}`],
      Labels: {
        "mycelium.project": projectName,
        "mycelium.run_id": runId,
        "mycelium.task_id": taskId,
      },
    };
  });

  containers.push({
    Id: "ignored",
    Names: ["/unrelated"],
    Labels: {
      "mycelium.project": "other",
      "mycelium.run_id": "other",
      "mycelium.task_id": "999",
    },
  });

  mocks.listContainersMock.mockResolvedValue(containers);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLogTypes(logFile: string): Promise<string[]> {
  const raw = await fs.readFile(logFile, "utf8");
  const types: string[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown };
      if (typeof parsed.type === "string") {
        types.push(parsed.type);
      }
    } catch {
      // ignore non-json lines
    }
  }

  return types;
}
