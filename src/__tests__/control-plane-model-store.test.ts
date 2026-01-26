import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { buildControlPlaneModel, getControlPlaneModelInfo } from "../control-plane/model/build.js";
import { ControlPlaneStore } from "../control-plane/storage.js";
import { MODEL_SCHEMA_VERSION } from "../control-plane/model/schema.js";

const tempDirs: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Control Plane Tests",
  GIT_AUTHOR_EMAIL: "control-plane@example.com",
  GIT_COMMITTER_NAME: "Control Plane Tests",
  GIT_COMMITTER_EMAIL: "control-plane@example.com",
};

// =============================================================================
// HELPERS
// =============================================================================

async function createTestRepo(): Promise<{ repoRoot: string; headSha: string }> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp-model-store-"));
  tempDirs.push(repoRoot);

  await execa("git", ["init"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "control plane test\n", "utf8");
  await execa("git", ["add", "."], { cwd: repoRoot });
  await execa("git", ["commit", "-m", "init"], { cwd: repoRoot, env: gitEnv });

  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return { repoRoot, headSha: head.stdout.trim() };
}

// =============================================================================
// TESTS
// =============================================================================

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("control-plane model store", () => {
  it("builds the model once and reuses cached metadata", async () => {
    const { repoRoot, headSha } = await createTestRepo();

    const buildResult = await buildControlPlaneModel({ repoRoot });

    expect(buildResult.base_sha).toBe(headSha);
    expect(buildResult.reused).toBe(false);
    expect(buildResult.metadata.schema_version).toBe(MODEL_SCHEMA_VERSION);

    const infoResult = await getControlPlaneModelInfo({ repoRoot });

    expect(infoResult.exists).toBe(true);
    expect(infoResult.base_sha).toBe(headSha);
    expect(infoResult.metadata?.built_at).toBe(buildResult.metadata.built_at);

    const secondBuild = await buildControlPlaneModel({ repoRoot });

    expect(secondBuild.reused).toBe(true);
    expect(secondBuild.metadata.built_at).toBe(buildResult.metadata.built_at);
  });

  it("refuses to build when the lock is already held", async () => {
    const { repoRoot, headSha } = await createTestRepo();
    const store = new ControlPlaneStore(repoRoot);
    const lock = await store.acquireBuildLock(headSha);

    let error: unknown;
    try {
      await buildControlPlaneModel({ repoRoot, baseSha: headSha });
    } catch (err) {
      error = err;
    } finally {
      await lock.release();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("lock");
  });
});
