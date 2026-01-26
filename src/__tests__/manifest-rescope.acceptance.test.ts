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
import { resolveTasksArchiveDir } from "../core/task-layout.js";

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

describe("acceptance: manifest enforcement auto-rescopes and retries", () => {
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
    "detects undeclared writes, updates the manifest, resets the task, and completes",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-rescope-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      // Mock planner output with an empty writes list so the mock worker writes
      // its fallback file (mock-output.txt), triggering compliance violations.
      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(
        plannerOutputPath,
        JSON.stringify(mockPlannerOutputWithEmptyWrites(), null, 2),
      );

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir, {
        manifestEnforcement: "warn",
      });

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

      // The first attempt violates the manifest; Mycelium auto-rescopes and retries.
      expect(runResult.state.tasks["001"]?.attempts).toBeGreaterThanOrEqual(2);

      // Manifest should have been updated to include the fallback file.
      const tasksRoot = path.join(repoDir, config.tasks_dir);
      const updatedManifest = await readPlannedManifest(
        tasksRoot,
        planResult.outputDir,
        runResult.runId,
      );
      expect(updatedManifest.files.writes).toContain("mock-output.txt");

      // The file should exist on the integration branch because the second attempt succeeded.
      const produced = await fs.readFile(path.join(repoDir, "mock-output.txt"), "utf8");
      expect(produced).toContain("Mock update");
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

async function writeProjectConfig(
  configPath: string,
  repoDir: string,
  opts: { manifestEnforcement: "off" | "warn" | "block" },
): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
    "planning_dir: .mycelium/planning",
    `manifest_enforcement: ${opts.manifestEnforcement}`,
    "doctor: 'node -e \"process.exit(0)\"'",
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

function mockPlannerOutputWithEmptyWrites(): unknown {
  return {
    tasks: [
      {
        id: "001",
        name: "rescope-demo",
        description: "Intentionally triggers manifest rescope by writing an undeclared file.",
        estimated_minutes: 5,
        dependencies: [],
        locks: { reads: [], writes: ["repo"] },
        files: { reads: [], writes: [] },
        affected_tests: [],
        test_paths: [],
        tdd_mode: "off",
        verify: { doctor: 'node -e "process.exit(0)"' },
        spec: "Write a small marker file used for testing Mycelium manifest rescope.",
      },
    ],
  };
}

async function readPlannedManifest(
  tasksRoot: string,
  outputDir: string,
  runId: string,
): Promise<any> {
  const planIndex = JSON.parse(await fs.readFile(path.join(outputDir, "_plan.json"), "utf8")) as {
    tasks: Array<{ dir: string }>;
  };
  const relDir = planIndex.tasks[0]?.dir;
  if (!relDir) {
    throw new Error("Plan index missing planned task directory");
  }
  const taskDirName = path.basename(relDir);
  const manifestPath = path.join(
    resolveTasksArchiveDir(tasksRoot),
    runId,
    taskDirName,
    "manifest.json",
  );
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}
