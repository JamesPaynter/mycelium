import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProject } from "../core/executor.js";
import { createPathsContext, taskEventsLogPath, type PathsContext } from "../core/paths.js";
import { buildTaskSlug, type TaskManifest } from "../core/task-manifest.js";

import {
  createMyceliumDevShimBinDir,
  createTempRepoFromFixture,
  readJsonl,
  writeLegacyTask,
  writeProjectConfigYaml,
} from "./control-graph-e2e.helpers.js";

// =============================================================================
// TYPES
// =============================================================================

type ControlGraphProof = {
  mode: "control_graph" | "fallback";
  owner_component_id: string | null;
  symbol_definition_path: string | null;
  errors: string[];
};

type CodexToolEvent = {
  type?: string;
  command?: string;
  exitCode?: number;
};

// =============================================================================
// TEST SETUP
// =============================================================================

const ENV_VARS = ["MYCELIUM_HOME", "MYCELIUM_TEST_CG", "MYCELIUM_TEST_CG_STUB", "PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const TEST_TASK_ID = "001";
const TEST_TASK_NAME = "Control graph proof";
const TEST_TASK_SPEC = [
  "# Test task",
  "",
  "This task exists only to prove worker control-graph CLI usage in automated tests.",
].join("\n");

const CONTROL_GRAPH_PROOF_PATH = "notes/cg-proof.json";

// =============================================================================
// TESTS
// =============================================================================

describe("acceptance: worker control graph usage", () => {
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

  it("runs mycelium cg commands in the worker and logs them", { timeout: 60_000 }, async () => {
    const setup = await setupControlGraphProject(cleanups, "control-graph-worker-usage");

    process.env.MYCELIUM_TEST_CG = "1";
    process.env.MYCELIUM_TEST_CG_STUB = "1";

    const shimDir = await createMyceliumDevShimBinDir();
    cleanups.push(async () => {
      await fs.rm(shimDir, { recursive: true, force: true });
    });
    prependToPath(shimDir);

    const runResult = await runProject(setup.projectName, setup.config, {
      maxParallel: 1,
      useDocker: false,
      buildImage: false,
      cleanupOnSuccess: true,
    });

    expect(runResult.state.status).toBe("complete");

    const proof = await readControlGraphProof(setup.repoDir);
    expect(proof.mode).toBe("control_graph");
    expect(proof.owner_component_id).toBe("acme-web-app");
    expect(proof.symbol_definition_path).toMatch(/packages\/utils\/src\/index\.ts$/);

    const events = await loadTaskEvents({
      projectName: setup.projectName,
      runId: runResult.runId,
      taskId: setup.manifest.id,
      taskSlug: setup.taskSlug,
      paths: setup.paths,
    });
    const toolEvents = extractCodexToolEvents(events);

    expect(hasCommand(toolEvents, "mycelium cg owner")).toBe(true);
    expect(hasCommand(toolEvents, "mycelium cg symbols find")).toBe(true);
  });

  it(
    "falls back when mycelium is unavailable and logs the failed command",
    { timeout: 60_000 },
    async () => {
      const setup = await setupControlGraphProject(cleanups, "control-graph-worker-fallback");

      process.env.MYCELIUM_TEST_CG = "1";

      const missingBin = await createMissingMyceliumBin(cleanups);
      prependToPath(missingBin);

      const runResult = await runProject(setup.projectName, setup.config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
        cleanupOnSuccess: true,
      });

      expect(runResult.state.status).toBe("complete");

      const proof = await readControlGraphProof(setup.repoDir);
      expect(proof.mode).toBe("fallback");
      expect(proof.symbol_definition_path).toMatch(/packages\/utils\/src\/index\.ts$/);
      expect(proof.errors.length).toBeGreaterThanOrEqual(1);

      const events = await loadTaskEvents({
        projectName: setup.projectName,
        runId: runResult.runId,
        taskId: setup.manifest.id,
        taskSlug: setup.taskSlug,
        paths: setup.paths,
      });
      const toolEvents = extractCodexToolEvents(events);
      const missingCg = toolEvents.find(
        (event) =>
          event.type === "tool.result" &&
          event.exitCode === 127 &&
          event.command?.startsWith("mycelium cg"),
      );

      expect(missingCg).toBeDefined();
    },
  );
});

// =============================================================================
// HELPERS
// =============================================================================

async function setupControlGraphProject(
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
  process.env.MYCELIUM_HOME = myceliumHome;

  const { config } = await writeProjectConfigYaml({
    myceliumHome,
    repoDir,
    projectName,
    controlPlane: { enabled: false },
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
    description: "Control graph worker acceptance test task.",
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

function prependToPath(dir: string): void {
  const current = process.env.PATH ?? "";
  process.env.PATH = current ? `${dir}${path.delimiter}${current}` : dir;
}

async function createMissingMyceliumBin(cleanups: Array<() => Promise<void>>): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-missing-"));
  const shimPath = path.join(binDir, "mycelium");
  const script = [
    "#!/usr/bin/env node",
    'console.error("mycelium intentionally unavailable for fallback test");',
    "process.exit(127);",
    "",
  ].join("\n");

  await fs.writeFile(shimPath, script, "utf8");
  await fs.chmod(shimPath, 0o755);

  cleanups.push(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  return binDir;
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
