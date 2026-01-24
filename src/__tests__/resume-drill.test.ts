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
import { orchestratorLogPath } from "../core/paths.js";
import { detectTasksLayout, resolveTasksActiveDir, resolveTasksBacklogDir } from "../core/task-layout.js";
import { StateStore } from "../core/state-store.js";
import type { RunState } from "../core/state.js";
import { dockerClient } from "../docker/docker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");
const DOCKER_IMAGE = "mycelium-worker:resume-drill";

const ENV_VARS = [
  "MYCELIUM_HOME",
  "MOCK_LLM",
  "MOCK_LLM_OUTPUT_PATH",
  "MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START",
] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const dockerGate = resolveDockerGate();
if (!dockerGate.enabled) {
  console.warn(`Skipping resume acceptance test: ${dockerGate.reason}`);
}

const describeDocker = dockerGate.enabled ? describe : describe.skip;

describeDocker("resume acceptance: orchestrator crash + resume reattaches", () => {
  const tempRoots: string[] = [];
  const runsToCleanup: Array<{ projectName: string; runId: string }> = [];
  const processes: Array<ReturnType<typeof execa>> = [];

  afterEach(async () => {
    for (const proc of processes) {
      try {
        proc.kill("SIGKILL");
        await proc.catch(() => undefined);
      } catch {
        // ignore
      }
    }
    processes.length = 0;

    for (const run of runsToCleanup) {
      await cleanupRunContainers(run.projectName, run.runId);
    }
    runsToCleanup.length = 0;

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
    "reattaches a running container and observes codex.thread.resumed after orchestrator crash",
    async () => {
      await ensureDockerAvailable();

      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resume-"));
      tempRoots.push(tempRoot);

      const repoDir = path.join(tempRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await writeBootstrapDelayScript(repoDir);
      await writeFailOnceDoctor(repoDir);
      await initGitRepo(repoDir);

      const projectName = "resume-drill";
      const runId = `${projectName}-${Date.now()}`;
      runsToCleanup.push({ projectName, runId });

      const configPath = path.join(tempRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir);

      process.env.MYCELIUM_HOME = path.join(tempRoot, ".mycelium");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");
      process.env.MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START = "1";

      await ensureImplementationPlan(repoDir);
      const config = loadProjectConfig(configPath);
      await planProject(projectName, config, {
        input: ".mycelium/planning/implementation-plan.md",
      });
      await overrideTaskDoctor(repoDir, "001", "node resume-doctor.js");

      const orchestratorLog = orchestratorLogPath(projectName, runId);
      const cliBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
      const runArgs = [
        "src/main.ts",
        "--config",
        configPath,
        "run",
        "--project",
        projectName,
        "--run-id",
        runId,
        "--max-parallel",
        "1",
        "--tasks",
        "001",
      ];
      const runProc = execa(cliBin, runArgs, {
        cwd: process.cwd(),
        env: process.env,
      });
      runProc.catch(() => undefined);
      processes.push(runProc);

      await waitForOrchestratorEvent(orchestratorLog, "container.start");
      runProc.kill("SIGKILL");
      await runProc.catch(() => undefined);

      const containersBeforeResume = await findRunContainers(projectName, runId);
      expect(containersBeforeResume.length).toBeGreaterThan(0);

      const resumeArgs = [
        "src/main.ts",
        "--config",
        configPath,
        "resume",
        "--project",
        projectName,
        "--run-id",
        runId,
        "--max-parallel",
        "1",
        "--no-build-image",
      ];
      delete process.env.MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START;
      const resumeResult = await execa(cliBin, resumeArgs, {
        cwd: process.cwd(),
        env: process.env,
      });
      expect(resumeResult.exitCode).toBe(0);

      const stateStore = new StateStore(projectName, runId);
      const state = await stateStore.load();
      expect(state.status).toBe("complete");
      expect(Object.values(state.tasks).every((task) => task.status === "complete")).toBe(true);

      const orchestratorEvents = await readJsonl(orchestratorLog);
      expect(orchestratorEvents.some((event) => event.type === "container.reattach")).toBe(true);

      const threadResumed = await hasThreadResumeEvent(state);
      expect(threadResumed).toBe(true);
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

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "resume@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Resume Tester"], { cwd: repoDir });
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
    "doctor: node -e \"process.exit(0)\"",
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
    `  image: ${DOCKER_IMAGE}`,
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

async function ensureImplementationPlan(repoDir: string): Promise<void> {
  const sourcePlan = path.join(repoDir, "docs", "planning", "implementation-plan.md");
  const planDir = path.join(repoDir, ".mycelium", "planning");
  const targetPlan = path.join(planDir, "implementation-plan.md");

  await fs.mkdir(planDir, { recursive: true });

  let contents = "# Implementation Plan\n";
  try {
    contents = await fs.readFile(sourcePlan, "utf8");
  } catch {
    // Fall back to a stub when fixtures change.
  }

  await fs.writeFile(targetPlan, contents, "utf8");
}

async function overrideTaskDoctor(
  repoDir: string,
  taskId: string,
  doctorCommand: string,
): Promise<void> {
  const tasksRoot = path.join(repoDir, ".mycelium", "tasks");
  const taskDir = await findTaskDir(tasksRoot, taskId);
  if (!taskDir) {
    throw new Error(`Task directory not found for ${taskId} in ${tasksRoot}`);
  }

  const manifestPath = path.join(taskDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { verify?: { doctor?: string } };
  const next = {
    ...manifest,
    verify: { ...manifest.verify, doctor: doctorCommand },
  };
  await fs.writeFile(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function findTaskDir(tasksRoot: string, taskId: string): Promise<string | null> {
  const layout = detectTasksLayout(tasksRoot);
  const searchRoots =
    layout === "legacy"
      ? [tasksRoot]
      : [resolveTasksBacklogDir(tasksRoot), resolveTasksActiveDir(tasksRoot)];

  for (const root of searchRoots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.startsWith(`${taskId}-`),
    );
    if (match) {
      return path.join(root, match.name);
    }
  }

  return null;
}

async function writeBootstrapDelayScript(repoDir: string): Promise<void> {
  const script = [
    "// Delay to keep the worker container alive during the resume drill.",
    "const delayMs = 8000;",
    "await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "console.log(`bootstrap delay complete (${delayMs}ms)`);",
    "",
  ].join("\n");
  await fs.writeFile(path.join(repoDir, "bootstrap-delay.js"), script, "utf8");
}

async function writeFailOnceDoctor(repoDir: string): Promise<void> {
  const script = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "",
    "const delayMs = 5000;",
    "await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "",
    "const guardPath = process.env.WORKER_FAIL_ONCE_FILE ?? path.join(process.cwd(), '.mycelium', 'codex-home', '.fail-once');",
    "if (!fs.existsSync(guardPath)) {",
    "  fs.mkdirSync(path.dirname(guardPath), { recursive: true });",
    "  fs.writeFileSync(guardPath, 'fail-once', 'utf8');",
    "  console.error('resume doctor: intentional first-attempt failure');",
    "  process.exit(1);",
    "}",
    "",
    "const doctorPath = path.join(process.cwd(), 'doctor.js');",
    "const result = spawnSync(process.execPath, [doctorPath], { stdio: 'inherit' });",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n");

  await fs.writeFile(path.join(repoDir, "resume-doctor.js"), script, "utf8");
}

async function waitForOrchestratorEvent(
  logPath: string,
  eventType: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await readJsonl(logPath).catch(() => null);
    if (events && events.some((event) => event.type === eventType)) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${eventType} in ${logPath}`);
}

async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}

async function hasThreadResumeEvent(state: RunState): Promise<boolean> {
  for (const task of Object.values(state.tasks)) {
    if (!task.logs_dir) continue;

    const eventsPath = path.join(task.logs_dir, "events.jsonl");
    const events = await readJsonl(eventsPath).catch(() => null);
    if (events?.some((event) => event.type === "codex.thread.resumed")) {
      return true;
    }
  }

  return false;
}

async function findRunContainers(projectName: string, runId: string): Promise<string[]> {
  const docker = dockerClient();
  const containers = await docker.listContainers({ all: true });
  return containers
    .filter(
      (c) =>
        c.Labels?.["mycelium.project"] === projectName && c.Labels?.["mycelium.run_id"] === runId,
    )
    .map((c) => c.Id);
}

async function cleanupRunContainers(projectName: string, runId: string): Promise<void> {
  const docker = dockerClient();
  const containerIds = await findRunContainers(projectName, runId);
  for (const id of containerIds) {
    const container = docker.getContainer(id);
    try {
      await container.remove({ force: true });
    } catch {
      // ignore
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
