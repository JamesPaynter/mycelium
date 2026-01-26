import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { __setMockCodexHandler } from "../../worker/codex.js";
import { loadProjectConfig } from "../core/config-loader.js";
import { runProject } from "../core/executor.js";
import { createPathsContext, orchestratorLogPath } from "../core/paths.js";
import { buildTaskDirName, type TaskManifest } from "../core/task-manifest.js";

// =============================================================================
// TEST SETUP
// =============================================================================

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MYCELIUM_WORKER_FAIL_ONCE_FILE"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("acceptance: ralph loop semantics", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    __setMockCodexHandler(null);

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
    "retries strict TDD Stage A on non-test drift without pausing the run",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-tdd-drift-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir, { maxRetries: 3 });

      const tasksRoot = path.join(repoDir, ".mycelium", "tasks");
      await writeTaskSpec(
        tasksRoot,
        {
          id: "001",
          name: "Strict TDD drift",
          description: "Ensure non-test drift retries Stage A.",
          estimated_minutes: 5,
          dependencies: [],
          locks: { reads: [], writes: ["repo"] },
          files: { reads: [], writes: ["tests/**"] },
          affected_tests: [],
          test_paths: ["tests/**"],
          tdd_mode: "strict",
          verify: {
            doctor: "true",
            fast: "bash -c 'exit 1'",
          },
        },
        "# Spec\n\nWrite failing tests first.\n",
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";

      const testFile = path.join("tests", "alpha.test.ts");
      __setMockCodexHandler(async ({ turn, workingDirectory }) => {
        if (turn === 1) {
          await fs.writeFile(path.join(workingDirectory, "README.md"), "drift\n", "utf8");
        }
        if (turn === 1 || turn === 2) {
          const fullTestPath = path.join(workingDirectory, testFile);
          await fs.mkdir(path.dirname(fullTestPath), { recursive: true });
          await fs.writeFile(fullTestPath, `test ${turn}\n`, "utf8");
        }
      });

      const config = loadProjectConfig(configPath);
      const runResult = await runProject("ralph-tdd-drift", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runResult.state.status).toBe("complete");
      expect(runResult.state.tasks["001"]?.status).toBe("complete");

      const logsDir = runResult.state.tasks["001"]?.logs_dir;
      expect(logsDir).toBeTruthy();

      const summaryRaw = await fs.readFile(
        path.join(logsDir ?? "", "attempt-001.summary.json"),
        "utf8",
      );
      const summary = JSON.parse(summaryRaw) as {
        tdd?: { non_test_changes_detected?: string[] };
      };

      expect(summary.tdd?.non_test_changes_detected).toContain("README.md");
    },
  );

  it(
    "retries a worker non-zero exit under retry policy and completes the run",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-worker-retry-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir, { taskFailurePolicy: "retry" });

      const tasksRoot = path.join(repoDir, ".mycelium", "tasks");
      await writeTaskSpec(
        tasksRoot,
        {
          id: "001",
          name: "Retry worker exit",
          description: "Force a worker failure and ensure the run retries.",
          estimated_minutes: 5,
          dependencies: [],
          locks: { reads: [], writes: ["repo"] },
          files: { reads: [], writes: ["notes/**"] },
          affected_tests: [],
          test_paths: [],
          tdd_mode: "off",
          verify: { doctor: "true" },
        },
        "# Spec\n\nWrite a simple file.\n",
      );

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MYCELIUM_WORKER_FAIL_ONCE_FILE = path.join(tmpRoot, "fail-once", "worker.txt");

      const config = loadProjectConfig(configPath);
      const runResult = await runProject("ralph-worker-retry", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runResult.state.status).toBe("complete");
      expect(runResult.state.tasks["001"]?.status).toBe("complete");
      expect(runResult.state.tasks["001"]?.attempts).toBe(2);

      const paths = createPathsContext({ myceliumHome: process.env.MYCELIUM_HOME });
      const orchestratorLog = orchestratorLogPath("ralph-worker-retry", runResult.runId, paths);
      const events = await readJsonl(orchestratorLog);

      expect(events.some((event) => event.type === "task.reset")).toBe(true);
    },
  );
});

// =============================================================================
// HELPERS
// =============================================================================

type JsonlEvent = { type?: string };

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}

async function initGitRepo(repoDir: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, "README.md"), "base\n", "utf8");

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
  overrides: { maxRetries?: number; taskFailurePolicy?: "retry" | "fail_fast" } = {},
): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const extraLines: string[] = [];

  if (overrides.maxRetries !== undefined) {
    extraLines.push(`max_retries: ${overrides.maxRetries}`);
  }
  if (overrides.taskFailurePolicy) {
    extraLines.push(`task_failure_policy: ${overrides.taskFailurePolicy}`);
  }

  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
    "planning_dir: .mycelium/planning",
    'doctor: "true"',
    "max_parallel: 1",
    ...extraLines,
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

async function writeTaskSpec(
  tasksRoot: string,
  manifest: TaskManifest,
  specContents: string,
): Promise<void> {
  const taskDirName = buildTaskDirName({ id: manifest.id, name: manifest.name });
  const taskDir = path.join(tasksRoot, "backlog", taskDirName);
  await fs.mkdir(taskDir, { recursive: true });

  await fs.writeFile(path.join(taskDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(taskDir, "spec.md"), specContents, "utf8");
}
