import fs from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { runProject } from "../core/executor.js";
import type { TaskManifest } from "../core/task-manifest.js";

import {
  createTempRepoFromFixture,
  readControlPlaneRunSummary,
  readTaskLockDerivationReport,
  writeLegacyTask,
  writeProjectConfigYaml,
} from "./control-graph-e2e.helpers.js";

// =============================================================================
// TEST SETUP
// =============================================================================

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const TEST_TASK_SPEC = [
  "# Test task",
  "",
  "This task exists only to exercise scheduling + lock derivation in automated tests.",
  "",
].join("\n");

// =============================================================================
// TESTS
// =============================================================================

describe("acceptance: control-graph derived lock scheduling", () => {
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
    "batches non-conflicting tasks using derived component locks",
    { timeout: 60_000 },
    async () => {
      const { tmpRoot, repoDir, cleanup } = await createTempRepoFromFixture();
      cleanups.push(cleanup);

      // Ensure the control-plane snapshot can resolve ownership for the write paths.
      await seedComponentFiles(repoDir);

      const tasksRoot = path.join(repoDir, ".mycelium", "tasks");
      const taskOne = buildManifest("001", "acme-web-task", ["apps/web/src/feature-a.ts"]);
      const taskTwo = buildManifest("002", "acme-utils-task", ["packages/utils/src/feature-b.ts"]);

      await writeLegacyTask(tasksRoot, taskOne, TEST_TASK_SPEC);
      await writeLegacyTask(tasksRoot, taskTwo, TEST_TASK_SPEC);

      const myceliumHome = path.join(tmpRoot, "mycelium-home");
      process.env.MYCELIUM_HOME = myceliumHome;

      const { projectName, config } = await writeProjectConfigYaml({
        myceliumHome,
        repoDir,
        projectName: "control-graph-derived-locks",
        controlPlane: {
          enabled: true,
          lock_mode: "derived",
          scope_mode: "off",
          fallback_resource: "repo",
        },
      });

      const runResult = await runProject(projectName, config, {
        maxParallel: 2,
        useDocker: false,
        buildImage: false,
        cleanupOnSuccess: true,
      });

      expect(runResult.state.status).toBe("complete");

      const firstBatch = runResult.plan[0];
      expect(firstBatch).toBeDefined();
      if (!firstBatch) {
        throw new Error("Expected at least one planned batch.");
      }

      expect(firstBatch.taskIds).toEqual(["001", "002"]);
      expect(firstBatch.locks.writes).toEqual(
        expect.arrayContaining(["component:acme-web-app", "component:acme-utils"]),
      );
      expect(firstBatch.locks.writes).not.toContain("repo");

      const taskOneReport = await readTaskLockDerivationReport(repoDir, runResult.runId, "001");
      expect(
        (taskOneReport as { derived_write_resources?: string[] }).derived_write_resources,
      ).toEqual(expect.arrayContaining(["component:acme-web-app"]));

      const taskTwoReport = await readTaskLockDerivationReport(repoDir, runResult.runId, "002");
      expect(
        (taskTwoReport as { derived_write_resources?: string[] }).derived_write_resources,
      ).toEqual(expect.arrayContaining(["component:acme-utils"]));

      const runSummary = await readControlPlaneRunSummary(repoDir, runResult.runId);
      expect(
        (runSummary as { metrics?: { derived_lock_mode_enabled?: boolean } }).metrics,
      ).toMatchObject({ derived_lock_mode_enabled: true });
    },
  );
});

// =============================================================================
// HELPERS
// =============================================================================

function buildManifest(id: string, name: string, writes: string[]): TaskManifest {
  return {
    id,
    name,
    description: "Derived lock scheduling test task.",
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: ["repo"] },
    files: { reads: [], writes },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: 'node -e "process.exit(0)"' },
  };
}

async function seedComponentFiles(repoDir: string): Promise<void> {
  const webPath = path.join(repoDir, "apps", "web", "src", "feature-a.ts");
  const utilsPath = path.join(repoDir, "packages", "utils", "src", "feature-b.ts");

  await fs.mkdir(path.dirname(webPath), { recursive: true });
  await fs.mkdir(path.dirname(utilsPath), { recursive: true });
  await fs.writeFile(webPath, "export const featureA = true;\n", "utf8");
  await fs.writeFile(utilsPath, "export const featureB = true;\n", "utf8");

  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "seed feature files"], { cwd: repoDir });
}
