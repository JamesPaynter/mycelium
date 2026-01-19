import { spawnSync } from "node:child_process";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");
const DOCKER_IMAGE = "mycelium-worker:test";

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MOCK_LLM_OUTPUT_PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const dockerGate = resolveDockerGate();
if (!dockerGate.enabled) {
  console.warn(`Skipping Docker smoke test: ${dockerGate.reason}`);
}

const describeDocker = dockerGate.enabled ? describe : describe.skip;

describeDocker("docker-mode end-to-end smoke (mock LLM)", () => {
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
    "runs worker tasks inside Docker and merges the results",
    async () => {
      await ensureDockerAvailable();

      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "docker-e2e-"));
      tempRoots.push(tempRoot);

      const repoDir = path.join(tempRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await initGitRepo(repoDir);

      const projectName = "docker-smoke";
      const runId = `${projectName}-${Date.now()}`;
      const configPath = path.join(tempRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      process.env.MYCELIUM_HOME = path.join(tempRoot, ".mycelium");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");

      const config = loadProjectConfig(configPath);
      const headBefore = await gitHead(repoDir, config.main_branch);
      const commitsBefore = await commitCount(repoDir, config.main_branch);

      const planResult = await planProject(projectName, config, {
        input: ".mycelium/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(2);

      const runResult = await runProject(projectName, config, {
        runId,
        maxParallel: 1,
        useDocker: true,
        cleanupOnSuccess: true,
        buildImage: true,
      });

      const headAfter = await gitHead(repoDir, config.main_branch);
      const commitsAfter = await commitCount(repoDir, config.main_branch);
      const releaseNotes = await fs.readFile(path.join(repoDir, "notes/release-notes.txt"), "utf8");
      const featureNotes = await fs.readFile(path.join(repoDir, "src/feature.txt"), "utf8");

      const orchestratorEvents = await readJsonl(
        orchestratorLogPath(projectName, runResult.runId),
      );

      const firstTaskId = planResult.tasks[0]?.id ?? "001";
      const firstTaskLogs = runResult.state.tasks[firstTaskId]?.logs_dir;
      expect(firstTaskLogs).toBeTruthy();
      const taskEvents = await readJsonl(path.join(firstTaskLogs as string, "events.jsonl"));

      expect(runResult.state.status).toBe("complete");
      expect(Object.values(runResult.state.tasks).every((t) => t.status === "complete")).toBe(true);
      expect(headAfter).not.toBe(headBefore);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
      expect(releaseNotes).toContain("Mock update");
      expect(featureNotes).toContain("Mock update");
      expect(orchestratorEvents.some((event) => event.type === "container.start")).toBe(true);
      expect(orchestratorEvents.some((event) => event.type === "container.exit")).toBe(true);
      expect(taskEvents.length).toBeGreaterThan(0);
      expect(
        taskEvents.some(
          (event) =>
            event.type !== undefined &&
            ["worker.start", "task.complete", "doctor.pass"].includes(event.type),
        ),
      ).toBe(true);
    },
    240_000,
  );
});

type JsonlEvent = { type?: string; [key: string]: unknown };

function resolveDockerGate(): { enabled: boolean; reason?: string } {
  const flag = process.env.RUN_DOCKER_TESTS;
  if (!flag || !["1", "true", "yes", "on"].includes(flag.toLowerCase())) {
    return { enabled: false, reason: "RUN_DOCKER_TESTS=1 not set" };
  }
  const availability = probeDockerAvailability();
  if (!availability.available) {
    return {
      enabled: false,
      reason: availability.reason ?? "Docker is not available (install/start Docker).",
    };
  }
  return { enabled: true };
}

async function ensureDockerAvailable(): Promise<void> {
  const availability = probeDockerAvailability();
  if (availability.available) return;

  const detail = availability.reason ?? "docker info failed";
  throw new Error(`Docker is required for this test: ${detail}`);
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "docker-e2e@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Docker E2E Tester"], { cwd: repoDir });
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
    "doctor: npm test",
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
    "docker:",
    `  image: ${DOCKER_IMAGE}`,
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

async function gitHead(repoDir: string, branch: string): Promise<string> {
  const res = await execa("git", ["rev-parse", branch], { cwd: repoDir });
  return res.stdout.trim();
}

async function commitCount(repoDir: string, branch: string): Promise<number> {
  const res = await execa("git", ["rev-list", "--count", branch], { cwd: repoDir });
  return parseInt(res.stdout.trim(), 10);
}

function probeDockerAvailability(): { available: boolean; reason?: string } {
  const res = spawnSync("docker", ["info"], { stdio: "pipe" });
  if (res.status === 0) return { available: true };

  const stderr = res.stderr?.toString("utf8").trim();
  const stdout = res.stdout?.toString("utf8").trim();
  const message =
    res.error?.message ??
    (stderr && stderr.length > 0 ? stderr : undefined) ??
    (stdout && stdout.length > 0 ? stdout : undefined);

  return { available: false, reason: message };
}

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}
