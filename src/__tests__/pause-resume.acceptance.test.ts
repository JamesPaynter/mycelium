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
import { StateStore } from "../core/state-store.js";
import { createRunState } from "../core/state.js";

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

describe("acceptance: paused runs and blocked dependencies", () => {
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
    "resumes a paused run and completes pending tasks while blocked tasks remain",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-paused-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(
        plannerOutputPath,
        JSON.stringify(buildPlannerOutput({
          tasks: [
            buildTask({
              id: "001",
              name: "blocked-rescope",
              writes: ["notes/blocked-rescope.txt"],
            }),
            buildTask({
              id: "002",
              name: "independent-task",
              writes: ["src/independent-task.txt"],
            }),
          ],
        })),
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const projectName = "paused-run";
      const runId = `${projectName}-${Date.now()}`;
      const config = loadProjectConfig(configPath);

      const planResult = await planProject(projectName, config, {
        input: "docs/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(2);

      const state = createRunState({
        runId,
        project: projectName,
        repoPath: repoDir,
        mainBranch: config.main_branch,
        taskIds: planResult.tasks.map((task) => task.id),
      });
      state.status = "paused";
      state.tasks["001"].status = "rescope_required";
      state.tasks["001"].last_error = "Rescope required: test fixture";
      state.tasks["001"].completed_at = new Date().toISOString();

      const store = new StateStore(projectName, runId);
      await store.save(state);

      const runResult = await runProject(projectName, config, {
        runId,
        resume: true,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runResult.state.status).toBe("paused");
      expect(runResult.state.tasks["001"]?.status).toBe("rescope_required");
      expect(runResult.state.tasks["002"]?.status).toBe("complete");

      const written = await fs.readFile(
        path.join(repoDir, "src", "independent-task.txt"),
        "utf8",
      );
      expect(written).toContain("Mock update");
    },
  );

  it(
    "pauses when pending tasks are blocked by dependencies",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-blocked-deps-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(
        plannerOutputPath,
        JSON.stringify(buildPlannerOutput({
          tasks: [
            buildTask({
              id: "001",
              name: "blocked-root",
              writes: ["notes/blocked-root.txt"],
            }),
            buildTask({
              id: "002",
              name: "blocked-dependent",
              writes: ["notes/blocked-dependent.txt"],
              dependencies: ["001"],
            }),
          ],
        })),
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const projectName = "blocked-deps";
      const runId = `${projectName}-${Date.now()}`;
      const config = loadProjectConfig(configPath);

      const planResult = await planProject(projectName, config, {
        input: "docs/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(2);

      const state = createRunState({
        runId,
        project: projectName,
        repoPath: repoDir,
        mainBranch: config.main_branch,
        taskIds: planResult.tasks.map((task) => task.id),
      });
      state.status = "running";
      state.tasks["001"].status = "rescope_required";
      state.tasks["001"].last_error = "Rescope required: test fixture";
      state.tasks["001"].completed_at = new Date().toISOString();

      const store = new StateStore(projectName, runId);
      await store.save(state);

      const runResult = await runProject(projectName, config, {
        runId,
        resume: true,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runResult.state.status).toBe("paused");
      expect(runResult.state.tasks["002"]?.status).toBe("pending");

      const pausedEvents = await readJsonl(orchestratorLogPath(projectName, runId));
      const pausedEvent = pausedEvents.find((event) => event.type === "run.paused");
      expect(pausedEvent).toBeDefined();
      expect(pausedEvent?.reason).toBe("blocked_dependencies");
      expect(pausedEvent?.blocked_tasks).toEqual([
        {
          task_id: "002",
          unmet_deps: [
            {
              dep_id: "001",
              dep_status: "rescope_required",
              dep_last_error: "Rescope required: test fixture",
            },
          ],
        },
      ]);
    },
  );
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
    description: `Task ${input.id} for pause/resume coverage.`,
    estimated_minutes: 5,
    dependencies: input.dependencies,
    locks: { reads: [], writes: ["repo"] },
    files: { reads: [], writes: input.writes },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "node -e \"process.exit(0)\"" },
    spec: `Update ${input.writes.join(", ")} for pause/resume coverage.`,
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

async function writeProjectConfig(configPath: string, repoDir: string): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
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

type JsonlEvent = { type?: string; [key: string]: unknown };

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}
