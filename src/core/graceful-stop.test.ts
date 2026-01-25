import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "./config-loader.js";
import { runProject } from "./executor.js";
import { orchestratorLogPath } from "./paths.js";
import { planFromImplementationPlan } from "./planner.js";
import { resolveTasksBacklogDir } from "./task-layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MOCK_LLM_OUTPUT_PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("graceful stop signals", () => {
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
    "logs run.stop and keeps state resumable after a stop signal",
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "graceful-stop-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await writeBootstrapDelayScript(repoDir);
      await initGitRepo(repoDir);
      await writeImplementationPlan(repoDir);

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      process.env.MYCELIUM_HOME = path.join(tmpRoot, ".mycelium");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");

      const config = loadProjectConfig(configPath);
      const projectName = "graceful-stop";
      const tasksRoot = path.join(config.repo_path, config.tasks_dir);
      const outputDir = resolveTasksBacklogDir(tasksRoot);

      await planFromImplementationPlan({
        projectName,
        config,
        inputPath: ".mycelium/planning/implementation-plan.md",
        outputDir,
      });
      const runId = `${projectName}-${Date.now()}`;

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort("SIGINT"), 200);

      const stoppedRun = await runProject(projectName, config, {
        runId,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
        stopSignal: controller.signal,
      });
      clearTimeout(abortTimer);

      expect(stoppedRun.stopped).toBeDefined();
      expect(stoppedRun.state.status).toBe("running");

      const orchestratorEvents = await readJsonl(orchestratorLogPath(projectName, runId));
      const stopEvents = orchestratorEvents.filter((event) => event.type === "run.stop");
      expect(stopEvents.length).toBeGreaterThan(0);
      expect(stopEvents.some((event) => event.reason === "signal")).toBe(true);

      const baseSha = stoppedRun.state.control_plane?.base_sha;
      expect(baseSha).toBeDefined();
      if (!baseSha) {
        throw new Error("Expected control_plane.base_sha to be set on stop.");
      }

      const updatedHead = await commitRepoChange(repoDir);
      expect(updatedHead).not.toBe(baseSha);

      const resumedRun = await runProject(projectName, config, {
        runId,
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
        resume: true,
      });

      expect(resumedRun.state.control_plane?.base_sha).toBe(baseSha);
      expect(resumedRun.state.status).toBe("complete");
    },
    30_000,
  );
});

type JsonlEvent = { type?: string; [key: string]: unknown };

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "graceful-stop@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Graceful Stop"], { cwd: repoDir });
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
    "doctor: 'node -e \"process.exit(0)\"'",
    "max_parallel: 1",
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
    "bootstrap:",
    '  - "node bootstrap-delay.js"',
    "docker:",
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

async function writeBootstrapDelayScript(repoDir: string): Promise<void> {
  const script = [
    "import { setTimeout as delay } from 'node:timers/promises';",
    "",
    "const delayMs = 1500;",
    "await delay(delayMs);",
    "console.log(`bootstrap delay complete (${delayMs}ms)`);",
    "",
  ].join("\n");

  await fs.writeFile(path.join(repoDir, "bootstrap-delay.js"), script, "utf8");
}

async function writeImplementationPlan(repoDir: string): Promise<void> {
  const planDir = path.join(repoDir, ".mycelium", "planning");
  await fse.ensureDir(planDir);
  const content = ["# Implementation Plan", "", "- Placeholder tasks", ""].join("\n");
  await fs.writeFile(path.join(planDir, "implementation-plan.md"), content, "utf8");
}

async function commitRepoChange(repoDir: string): Promise<string> {
  const relativePath = path.join("notes", "resume-marker.txt");
  const absolutePath = path.join(repoDir, relativePath);

  await fs.writeFile(absolutePath, "resume marker\n", "utf8");
  await execa("git", ["add", relativePath], { cwd: repoDir });
  await execa("git", ["commit", "-m", "resume marker"], { cwd: repoDir });

  return await gitHead(repoDir, "HEAD");
}

async function gitHead(repoDir: string, ref: string): Promise<string> {
  const result = await execa("git", ["rev-parse", ref], { cwd: repoDir });
  return result.stdout.trim();
}

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}
