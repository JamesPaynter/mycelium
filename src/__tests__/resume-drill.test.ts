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
import { StateStore } from "../core/state-store.js";

import {
  cleanupRunContainers,
  ensureDockerAvailable,
  ensureImplementationPlan,
  findRunContainers,
  hasThreadResumeEvent,
  initGitRepo,
  overrideTaskDoctor,
  readJsonl,
  resolveDockerGate,
  waitForOrchestratorEvent,
  writeBootstrapDelayScript,
  writeFailOnceDoctor,
  writeProjectConfig,
} from "./resume-drill.helpers.js";

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

  it("reattaches a running container and observes codex.thread.resumed after orchestrator crash", async () => {
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
    await writeProjectConfig(configPath, repoDir, DOCKER_IMAGE);

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
  }, 240_000);
});
