import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../index.js";
import { runLogsDir, runStatePath, runWorkspaceDir } from "../core/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MOCK_LLM_OUTPUT_PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("acceptance: CLI plan -> run -> status -> clean", () => {
  const tempRoots: string[] = [];
  let originalCwd: string;

  afterEach(async () => {
    if (originalCwd) {
      process.chdir(originalCwd);
    }

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

    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it(
    "executes a full local-worker run via CLI and cleans artifacts",
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-cli-acceptance-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      const projectName = "cli-acceptance";
      const runId = `${projectName}-${Date.now()}`;

      process.env.MYCELIUM_HOME = path.join(tmpRoot, ".mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");

      originalCwd = process.cwd();
      process.chdir(repoDir);

      const consoleLines: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        consoleLines.push(args.map(String).join(" "));
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        consoleLines.push(args.map(String).join(" "));
      });

      process.exitCode = 0;

      await main([
        "node",
        "mycelium",
        "--config",
        configPath,
        "plan",
        "--project",
        projectName,
        "--input",
        "docs/planning/implementation-plan.md",
      ]);

      expect(errorSpy).not.toHaveBeenCalled();

      const tasksDir = path.join(repoDir, ".mycelium", "tasks", "backlog");
      const taskEntries = await fs.readdir(tasksDir);
      expect(taskEntries.some((entry) => entry.startsWith("001-"))).toBe(true);
      expect(taskEntries.some((entry) => entry.startsWith("002-"))).toBe(true);

      await main([
        "node",
        "mycelium",
        "--config",
        configPath,
        "run",
        "--project",
        projectName,
        "--run-id",
        runId,
        "--local-worker",
        "--max-parallel",
        "2",
        "--no-build-image",
      ]);

      const releaseNotes = await fs.readFile(
        path.join(repoDir, "notes", "release-notes.txt"),
        "utf8",
      );
      expect(releaseNotes).toContain("Mock update");

      const featureTracker = await fs.readFile(path.join(repoDir, "src", "feature.txt"), "utf8");
      expect(featureTracker).toContain("Mock update");

      logSpy.mockClear();
      await main([
        "node",
        "mycelium",
        "--config",
        configPath,
        "status",
        "--project",
        projectName,
        "--run-id",
        runId,
      ]);

      const statusOutput = logSpy.mock.calls.flat().map(String).join("\n");
      expect(statusOutput).toContain(`Run: ${runId}`);
      expect(statusOutput).toMatch(/Status: (complete|failed|running)/);

      await main([
        "node",
        "mycelium",
        "--config",
        configPath,
        "clean",
        "--project",
        projectName,
        "--run-id",
        runId,
        "--force",
        "--no-containers",
      ]);

      const stateFile = runStatePath(projectName, runId);
      const logsPath = runLogsDir(projectName, runId);
      const workspacePath = runWorkspaceDir(projectName, runId);

      expect(await fse.pathExists(stateFile)).toBe(false);
      expect(await fse.pathExists(logsPath)).toBe(false);
      expect(await fse.pathExists(workspacePath)).toBe(false);

      expect(consoleLines.join("\n")).toContain("finished with status");
    },
    60_000,
  );
});

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cli-acceptance@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "CLI Acceptance"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

async function writeProjectConfig(configPath: string, repoDir: string): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();

  const configContents = [
    `repo_path: ${JSON.stringify(repoDir)}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
    "planning_dir: .mycelium/planning",
    "doctor: npm test",
    "max_parallel: 2",
    "resources:",
    '  - name: docs',
    '    paths: ["notes/**"]',
    '  - name: code',
    '    paths: ["src/**"]',
    "planner:",
    "  provider: mock",
    "  model: mock",
    "worker:",
    "  model: mock",
    "  checkpoint_commits: true",
    "docker:",
    `  dockerfile: ${JSON.stringify(dockerfile)}`,
    `  build_context: ${JSON.stringify(buildContext)}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}
