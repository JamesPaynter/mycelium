import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { listChangedPaths } from "../control-plane/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const tempDirs: string[] = [];

// =============================================================================
// HELPERS
// =============================================================================

async function createTempRepoFromFixture(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-git-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  return repoDir;
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cp-git@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Control Plane Git"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", message], { cwd: repoDir });
}

async function appendLine(repoDir: string, relativePath: string, line: string): Promise<void> {
  const absolutePath = path.join(repoDir, relativePath);
  await fs.appendFile(absolutePath, `\n${line}\n`);
}

async function resolveGitSha(repoDir: string, revision: string): Promise<string> {
  const result = await execa("git", ["rev-parse", revision], { cwd: repoDir });
  return result.stdout.trim();
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane git helpers", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("lists changed paths from a diff range", async () => {
    const repoDir = await createTempRepoFromFixture();
    const targetPath = "packages/utils/src/index.ts";

    await appendLine(repoDir, targetPath, "// blast diff");
    await commitAll(repoDir, "Update utils");

    const changedPaths = await listChangedPaths({
      repoRoot: repoDir,
      diff: "HEAD~1..HEAD",
    });

    expect(changedPaths).toEqual([targetPath]);
  });

  it("lists changed paths against a ref", async () => {
    const repoDir = await createTempRepoFromFixture();
    const baseSha = await resolveGitSha(repoDir, "HEAD");
    const targetPath = "apps/web/src/index.ts";

    await appendLine(repoDir, targetPath, "// blast against");
    await commitAll(repoDir, "Update web");

    const changedPaths = await listChangedPaths({
      repoRoot: repoDir,
      against: baseSha,
    });

    expect(changedPaths).toEqual([targetPath]);
  });

  it("rejects multiple change sources", async () => {
    const repoDir = await createTempRepoFromFixture();

    await expect(
      listChangedPaths({
        repoRoot: repoDir,
        changed: ["packages/utils/src/index.ts"],
        diff: "HEAD~1..HEAD",
      }),
    ).rejects.toThrow("Provide only one of --changed, --diff, or --against.");
  });
});
