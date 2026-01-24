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
import { taskWorkspaceDir } from "../core/paths.js";

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

describe("acceptance: cleanup workspaces on success", () => {
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
    "removes task workspaces after integration doctor passes",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-cleanup-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(plannerOutputPath, JSON.stringify(mockPlannerOutput(), null, 2));

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const config = loadProjectConfig(configPath);

      const planResult = await planProject("toy-project", config, {
        input: "docs/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(1);

      const runResult = await runProject("toy-project", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      expect(runResult.state.status).toBe("complete");

      const taskId = planResult.tasks[0]?.id ?? "001";
      const workspacePath = taskWorkspaceDir("toy-project", runResult.runId, taskId);
      expect(await fse.pathExists(workspacePath)).toBe(false);
    },
  );
});

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
    "manifest_enforcement: off",
    "doctor: 'node -e \"process.exit(0)\"'",
    "max_parallel: 1",
    "cleanup:",
    "  workspaces: on_success",
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

function mockPlannerOutput(): unknown {
  return {
    tasks: [
      {
        id: "001",
        name: "cleanup-demo",
        description: "Ensure workspace is removed after success.",
        estimated_minutes: 5,
        dependencies: [],
        locks: { reads: [], writes: ["repo"] },
        files: { reads: [], writes: [] },
        affected_tests: [],
        test_paths: [],
        tdd_mode: "off",
        verify: { doctor: "node -e \"process.exit(0)\"" },
        spec: "Touch a file so the worker produces a change and the task completes.",
      },
    ],
  };
}
