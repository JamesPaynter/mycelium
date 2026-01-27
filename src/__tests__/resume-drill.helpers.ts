import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import {
  detectTasksLayout,
  resolveTasksActiveDir,
  resolveTasksBacklogDir,
} from "../core/task-layout.js";
import { dockerClient } from "../docker/docker.js";

type JsonlEvent = { type?: string; [key: string]: unknown };

// =============================================================================
// DOCKER GATE
// =============================================================================

export function resolveDockerGate(): { enabled: boolean; reason?: string } {
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

export async function ensureDockerAvailable(): Promise<void> {
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

// =============================================================================
// FIXTURE SETUP
// =============================================================================

export async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "resume@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Resume Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

export async function writeProjectConfig(
  configPath: string,
  repoDir: string,
  dockerImage: string,
): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
    'doctor: node -e "process.exit(0)"',
    "max_parallel: 1",
    "resources:",
    "  - name: docs",
    '    paths: ["notes/**"]',
    "  - name: code",
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
    `  image: ${dockerImage}`,
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

export async function ensureImplementationPlan(repoDir: string): Promise<void> {
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

export async function overrideTaskDoctor(
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

export async function writeBootstrapDelayScript(repoDir: string): Promise<void> {
  const script = [
    "// Delay to keep the worker container alive during the resume drill.",
    "const delayMs = 8000;",
    "await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "console.log(`bootstrap delay complete (${delayMs}ms)`);",
    "",
  ].join("\n");
  await fs.writeFile(path.join(repoDir, "bootstrap-delay.js"), script, "utf8");
}

export async function writeFailOnceDoctor(repoDir: string): Promise<void> {
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

// =============================================================================
// ORCHESTRATOR ASSERTIONS
// =============================================================================

export async function waitForOrchestratorEvent(
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

export async function readJsonl(filePath: string): Promise<JsonlEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}

export async function findRunContainers(projectName: string, runId: string): Promise<string[]> {
  const docker = dockerClient();
  const containers = await docker.listContainers({ all: true });
  return containers
    .filter(
      (c) =>
        c.Labels?.["mycelium.project"] === projectName && c.Labels?.["mycelium.run_id"] === runId,
    )
    .map((c) => c.Id);
}

export async function cleanupRunContainers(projectName: string, runId: string): Promise<void> {
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

export async function hasThreadResumeEvent(
  state: { tasks: Record<string, { logs_dir?: string | null }> },
): Promise<boolean> {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
