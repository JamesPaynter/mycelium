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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MOCK_LLM_OUTPUT_PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("acceptance: integration doctor failure keeps tasks from completing", () => {
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
    "marks tasks as needs_human_review when integration doctor fails",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-doctor-fail-"));
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

      expect(runResult.state.status).toBe("failed");
      expect(runResult.state.tasks["001"]?.status).toBe("needs_human_review");
      expect(runResult.state.batches[0]?.integration_doctor_passed).toBe(false);
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
    "doctor: 'node -e \"process.exit(1)\"'",
    "max_parallel: 1",
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
        name: "doctor-failure-demo",
        description: "Triggers integration doctor failure after merge.",
        estimated_minutes: 5,
        dependencies: [],
        locks: { reads: [], writes: ["repo"] },
        files: { reads: [], writes: ["notes/release-notes.txt"] },
        affected_tests: [],
        test_paths: [],
        tdd_mode: "off",
        verify: { doctor: "npm test" },
        spec: "Write a small doc update; integration doctor will fail.",
      },
    ],
  };
}
