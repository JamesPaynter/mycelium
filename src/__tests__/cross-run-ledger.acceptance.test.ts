import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { planProject } from "../cli/plan.js";
import { loadProjectConfig } from "../core/config-loader.js";
import { runProject } from "../core/executor.js";
import { orchestratorLogPath } from "../core/paths.js";
import { resolveTaskManifestPath, resolveTaskSpecPath } from "../core/task-layout.js";
import { loadTaskSpecs } from "../core/task-loader.js";
import { buildTaskDirName } from "../core/task-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");

const ENV_VARS = [
  "MYCELIUM_HOME",
  "MOCK_LLM",
  "MOCK_LLM_OUTPUT_PATH",
  "MOCK_LLM_OUTPUT",
  "MOCK_CODEX_USAGE",
] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

// =============================================================================
// TESTS
// =============================================================================

describe("acceptance: cross-run ledger dependencies", () => {
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
  });

  it(
    "reuses ledger completions to satisfy external dependencies across runs",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-ledger-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(
        plannerOutputPath,
        JSON.stringify(
          buildPlannerOutput({
            tasks: [
              buildTask({
                id: "001",
                name: "seed-ledger",
                writes: ["notes/seed-ledger.txt"],
              }),
              buildTask({
                id: "002",
                name: "downstream-task",
                writes: ["src/downstream-task.txt"],
                dependencies: ["001"],
              }),
            ],
          }),
        ),
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const projectName = "cross-run-ledger";
      const config = loadProjectConfig(configPath);

      const planResult = await planProject(projectName, config, {
        input: "docs/planning/implementation-plan.md",
        output: ".tasks",
      });
      expect(planResult.tasks).toHaveLength(2);

      const runOne = await runProject(projectName, config, {
        runId: `${projectName}-run-1-${Date.now()}`,
        tasks: ["001"],
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runOne.state.status).toBe("complete");
      expect(runOne.state.tasks["001"]?.status).toBe("complete");

      const runTwo = await runProject(projectName, config, {
        runId: `${projectName}-run-2-${Date.now()}`,
        tasks: ["002"],
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runTwo.state.status).toBe("complete");
      expect(runTwo.state.tasks["002"]?.status).toBe("complete");

      const events = await readJsonl(orchestratorLogPath(projectName, runTwo.runId));
      const externalSatisfied = events.find((event) => event.type === "deps.external_satisfied");
      expect(externalSatisfied).toBeDefined();
      expect(externalSatisfied?.task_id).toBe("002");
      expect(externalSatisfied?.deps).toEqual(
        expect.arrayContaining([expect.objectContaining({ dep_id: "001" })]),
      );
    },
  );

  it(
    "reuses ledger completions when archived tasks are nested under run directories",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-ledger-archive-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      const tasksDir = ".mycelium/tasks";
      await writeProjectConfig(configPath, repoDir, tasksDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(
        plannerOutputPath,
        JSON.stringify(
          buildPlannerOutput({
            tasks: [
              buildTask({
                id: "001",
                name: "seed-ledger",
                writes: ["notes/seed-ledger.txt"],
              }),
              buildTask({
                id: "002",
                name: "downstream-task",
                writes: ["src/downstream-task.txt"],
                dependencies: ["001"],
              }),
            ],
          }),
        ),
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const projectName = "cross-run-ledger-archive";
      const config = loadProjectConfig(configPath);

      const planResult = await planProject(projectName, config, {
        input: "docs/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(2);

      const runOneId = "run-20260130-120000";
      const runOne = await runProject(projectName, config, {
        runId: runOneId,
        tasks: ["001"],
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runOne.state.status).toBe("complete");
      expect(runOne.state.tasks["001"]?.status).toBe("complete");

      const taskDirName = buildTaskDirName({ id: "001", name: "seed-ledger" });
      const tasksRoot = path.join(repoDir, tasksDir);
      const archivedTaskDir = path.join(tasksRoot, "archive", runOneId, taskDirName);
      expect(await fse.pathExists(archivedTaskDir)).toBe(true);

      const nestedArchiveDir = path.join(tasksRoot, "archive", runOneId, "nested", taskDirName);
      await fse.ensureDir(path.dirname(nestedArchiveDir));
      await fse.move(archivedTaskDir, nestedArchiveDir);

      const runTwo = await runProject(projectName, config, {
        runId: "run-20260130-121000",
        tasks: ["002"],
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runTwo.state.status).toBe("complete");
      expect(runTwo.state.tasks["002"]?.status).toBe("complete");

      const events = await readJsonl(orchestratorLogPath(projectName, runTwo.runId));
      const externalSatisfied = events.find((event) => event.type === "deps.external_satisfied");
      expect(externalSatisfied).toBeDefined();
      expect(externalSatisfied?.task_id).toBe("002");
      expect(externalSatisfied?.deps).toEqual(
        expect.arrayContaining([expect.objectContaining({ dep_id: "001" })]),
      );
    },
  );

  it("blocks reuse when dependency fingerprint changes", { timeout: 60_000 }, async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-ledger-mismatch-"));
    tempRoots.push(tmpRoot);

    const repoDir = path.join(tmpRoot, "repo");
    await fse.copy(FIXTURE_REPO, repoDir);
    await initGitRepo(repoDir);

    const configPath = path.join(tmpRoot, "project.yaml");
    await writeProjectConfig(configPath, repoDir);

    const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
    await fs.writeFile(
      plannerOutputPath,
      JSON.stringify(
        buildPlannerOutput({
          tasks: [
            buildTask({
              id: "001",
              name: "seed-ledger",
              writes: ["notes/seed-ledger.txt"],
            }),
            buildTask({
              id: "002",
              name: "downstream-task",
              writes: ["src/downstream-task.txt"],
              dependencies: ["001"],
            }),
          ],
        }),
      ),
    );

    process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
    process.env.MOCK_LLM = "1";
    process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
    delete process.env.MOCK_LLM_OUTPUT;
    delete process.env.MOCK_CODEX_USAGE;

    const projectName = "cross-run-ledger-mismatch";
    const config = loadProjectConfig(configPath);

    const planResult = await planProject(projectName, config, {
      input: "docs/planning/implementation-plan.md",
      output: ".tasks",
    });
    expect(planResult.tasks).toHaveLength(2);

    const runOne = await runProject(projectName, config, {
      runId: `${projectName}-run-1-${Date.now()}`,
      tasks: ["001"],
      maxParallel: 1,
      useDocker: false,
      buildImage: false,
    });

    expect(runOne.state.status).toBe("complete");

    const taskPaths = await resolveTaskFiles(repoDir, config.tasks_dir, "001");
    await fs.appendFile(taskPaths.specPath, "\nFingerprint change for reuse check.\n", "utf8");

    const runTwo = await runProject(projectName, config, {
      runId: `${projectName}-run-2-${Date.now()}`,
      tasks: ["002"],
      maxParallel: 1,
      useDocker: false,
      buildImage: false,
    });

    expect(runTwo.state.status).toBe("failed");
    expect(runTwo.state.tasks["002"]?.status).toBe("pending");

    const events = await readJsonl(orchestratorLogPath(projectName, runTwo.runId));
    const blockedEvent = events.find((event) => event.type === "run.blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.reason).toBe("missing_dependencies");
    expect(blockedEvent?.blocked_tasks).toEqual([{ task_id: "002", missing_deps: ["001"] }]);
  });
});

// =============================================================================
// HELPERS
// =============================================================================

type PlannerOutput = {
  tasks: Array<{
    id: string;
    name: string;
    description: string;
    estimated_minutes: number;
    dependencies?: string[];
    locks: { reads: string[]; writes: string[] };
    files: { reads: string[]; writes: string[] };
    affected_tests: string[];
    test_paths: string[];
    tdd_mode: "off";
    verify: { doctor: string };
    spec: string;
  }>;
};

function buildPlannerOutput(output: PlannerOutput): PlannerOutput {
  return output;
}

function buildTask(input: {
  id: string;
  name: string;
  writes: string[];
  dependencies?: string[];
}): PlannerOutput["tasks"][number] {
  return {
    id: input.id,
    name: input.name,
    description: `Task ${input.id} for ledger acceptance coverage.`,
    estimated_minutes: 5,
    dependencies: input.dependencies,
    locks: { reads: [], writes: ["repo"] },
    files: { reads: [], writes: input.writes },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: 'node -e "process.exit(0)"' },
    spec: `Update ${input.writes.join(", ")} for ledger coverage.`,
  };
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "integration@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Integration Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

async function writeProjectConfig(
  configPath: string,
  repoDir: string,
  tasksDir = ".tasks",
): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    `tasks_dir: ${tasksDir}`,
    "planning_dir: .mycelium/planning",
    "doctor: 'node -e \"process.exit(0)\"'",
    "max_parallel: 2",
    "resources:",
    "  - name: repo",
    '    paths: ["**/*"]',
    "planner:",
    "  provider: mock",
    "  model: mock",
    "worker:",
    "  model: mock",
    "  checkpoint_commits: true",
    "docker:",
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

async function resolveTaskFiles(
  repoDir: string,
  tasksDir: string,
  taskId: string,
): Promise<{ manifestPath: string; specPath: string }> {
  const { tasks } = await loadTaskSpecs(repoDir, tasksDir);
  const task = tasks.find((entry) => entry.manifest.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in ${tasksDir}.`);
  }

  const tasksRoot = path.join(repoDir, tasksDir);
  return {
    manifestPath: resolveTaskManifestPath({
      tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    }),
    specPath: resolveTaskSpecPath({
      tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    }),
  };
}

type JsonlEvent = { type?: string; [key: string]: unknown };

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}
