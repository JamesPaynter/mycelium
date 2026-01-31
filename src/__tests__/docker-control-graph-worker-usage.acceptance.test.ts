import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProject } from "../core/executor.js";
import {
  createPathsContext,
  orchestratorLogPath,
  taskEventsLogPath,
  type PathsContext,
} from "../core/paths.js";
import { buildTaskSlug, type TaskManifest } from "../core/task-manifest.js";

import {
  createTempRepoFromFixture,
  readJsonl,
  writeLegacyTask,
  writeProjectConfigYaml,
} from "./control-graph-e2e.helpers.js";
import { ensureDockerAvailable, resolveDockerGate } from "./resume-drill.helpers.js";

// =============================================================================
// TYPES
// =============================================================================

type ControlGraphProof = {
  mode: "control_graph" | "fallback";
  owner_component_id: string | null;
  symbol_definition_path: string | null;
};

type CodexToolEvent = {
  type?: string;
  command?: string;
  exitCode?: number;
};

// =============================================================================
// TEST SETUP
// =============================================================================

const DOCKER_IMAGE = "mycelium-worker:cg-usage";
const DOCKERFILE_PATH = path.resolve(process.cwd(), "templates/Dockerfile");
const DOCKER_BUILD_CONTEXT = process.cwd();
const DOCKER_USER = "worker";
const DOCKER_NETWORK_MODE = "bridge";

const TEST_TASK_ID = "001";
const TEST_TASK_NAME = "Control graph proof";
const TEST_TASK_SPEC = [
  "# Test task",
  "",
  "This task exists only to prove worker control-graph CLI usage in Docker-mode automated tests.",
].join("\n");

const CONTROL_GRAPH_PROOF_PATH = "notes/cg-proof.json";

const ENV_VARS = ["MYCELIUM_HOME", "MYCELIUM_TEST_CG"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const dockerGate = resolveDockerGate();
if (!dockerGate.enabled) {
  console.warn(`Skipping Docker control graph worker usage test: ${dockerGate.reason}`);
}

const describeDocker = dockerGate.enabled ? describe : describe.skip;

// =============================================================================
// TESTS
// =============================================================================

describeDocker("docker-mode acceptance: worker control graph usage", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;

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
    "runs mycelium cg commands in the worker container and records proof",
    { timeout: 240_000 },
    async () => {
      await ensureDockerAvailable();

      const setup = await setupDockerControlGraphProject(
        cleanups,
        "docker-control-graph-worker-usage",
      );
      process.env.MYCELIUM_HOME = setup.myceliumHome;
      process.env.MYCELIUM_TEST_CG = "1";

      const runResult = await runProject(setup.projectName, setup.config, {
        maxParallel: 1,
        useDocker: true,
        buildImage: true,
        cleanupOnSuccess: true,
      });

      expect(runResult.state.status).toBe("complete");

      const proof = await readControlGraphProof(setup.repoDir);
      expect(proof.mode).toBe("control_graph");
      expect(proof.owner_component_id).toBe("acme-web-app");
      expect(proof.symbol_definition_path).toMatch(/packages\/utils\/src\/index\.ts$/);

      const taskEvents = await loadTaskEvents({
        projectName: setup.projectName,
        runId: runResult.runId,
        taskId: setup.manifest.id,
        taskSlug: setup.taskSlug,
        paths: setup.paths,
      });
      const toolEvents = extractCodexToolEvents(taskEvents);
      expect(hasCommand(toolEvents, "mycelium cg owner")).toBe(true);

      const orchestratorEvents = await readJsonl(
        orchestratorLogPath(setup.projectName, runResult.runId, setup.paths),
      );
      expect(orchestratorEvents.some((event) => event.type === "container.start")).toBe(true);
      expect(orchestratorEvents.some((event) => event.type === "container.exit")).toBe(true);
    },
  );
});

// =============================================================================
// HELPERS
// =============================================================================

async function setupDockerControlGraphProject(
  cleanups: Array<() => Promise<void>>,
  projectName: string,
): Promise<{
  repoDir: string;
  myceliumHome: string;
  projectName: string;
  config: Awaited<ReturnType<typeof writeProjectConfigYaml>>["config"];
  manifest: TaskManifest;
  taskSlug: string;
  paths: PathsContext;
}> {
  const { tmpRoot, repoDir, cleanup } = await createTempRepoFromFixture();
  cleanups.push(cleanup);

  const manifest = buildManifest();
  const tasksRoot = path.join(repoDir, ".mycelium", "tasks");
  await writeLegacyTask(tasksRoot, manifest, TEST_TASK_SPEC);

  const myceliumHome = path.join(tmpRoot, "mycelium-home");
  const { config } = await writeProjectConfigYaml({
    myceliumHome,
    repoDir,
    projectName,
    docker: {
      image: DOCKER_IMAGE,
      dockerfile: DOCKERFILE_PATH,
      build_context: DOCKER_BUILD_CONTEXT,
      user: DOCKER_USER,
      network_mode: DOCKER_NETWORK_MODE,
    },
  });

  return {
    repoDir,
    myceliumHome,
    projectName,
    config,
    manifest,
    taskSlug: buildTaskSlug(manifest.name),
    paths: createPathsContext({ myceliumHome }),
  };
}

function buildManifest(): TaskManifest {
  return {
    id: TEST_TASK_ID,
    name: TEST_TASK_NAME,
    description: "Control graph worker Docker acceptance test task.",
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: [CONTROL_GRAPH_PROOF_PATH] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: 'node -e "process.exit(0)"' },
  };
}

async function readControlGraphProof(repoDir: string): Promise<ControlGraphProof> {
  const proofPath = path.join(repoDir, CONTROL_GRAPH_PROOF_PATH);
  const raw = await fs.readFile(proofPath, "utf8");
  return JSON.parse(raw) as ControlGraphProof;
}

async function loadTaskEvents(input: {
  projectName: string;
  runId: string;
  taskId: string;
  taskSlug: string;
  paths: PathsContext;
}): Promise<Array<Record<string, unknown>>> {
  const logPath = taskEventsLogPath(
    input.projectName,
    input.runId,
    input.taskId,
    input.taskSlug,
    input.paths,
  );

  return (await readJsonl(logPath)) as Array<Record<string, unknown>>;
}

function extractCodexToolEvents(events: Array<Record<string, unknown>>): CodexToolEvent[] {
  const toolEvents: CodexToolEvent[] = [];

  for (const event of events) {
    if (event.type !== "codex.event") {
      continue;
    }

    const payload = event.payload as { event?: unknown; payload?: { event?: unknown } } | undefined;
    const codexEvent = payload?.event ?? payload?.payload?.event;
    if (!codexEvent || typeof codexEvent !== "object") {
      continue;
    }

    const raw = codexEvent as { type?: unknown; command?: unknown; exit_code?: unknown };
    const entry: CodexToolEvent = {};

    if (typeof raw.type === "string") entry.type = raw.type;
    if (typeof raw.command === "string") entry.command = raw.command;
    if (typeof raw.exit_code === "number") {
      entry.exitCode = raw.exit_code;
    } else if (typeof raw.exit_code === "string") {
      const parsed = Number(raw.exit_code);
      if (Number.isFinite(parsed)) entry.exitCode = parsed;
    }

    toolEvents.push(entry);
  }

  return toolEvents;
}

function hasCommand(events: CodexToolEvent[], substring: string): boolean {
  return events.some((event) => event.command?.includes(substring));
}
