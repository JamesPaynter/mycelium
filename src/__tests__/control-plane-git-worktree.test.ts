import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitWorktreeAtRevision } from "../control-plane/git/worktree.js";

import { createTempGitRepo } from "./helpers/temp-git-repo.js";

type TempRepoHandle = Awaited<ReturnType<typeof createTempGitRepo>>;

let repoHandle: TempRepoHandle | null = null;

afterEach(async () => {
  if (!repoHandle) return;
  await repoHandle.cleanup();
  repoHandle = null;
});

// =============================================================================
// HELPERS
// =============================================================================

type SnapshotRead = {
  sha: string;
  worktreeRoot: string;
  contents: string;
};

async function readFileFromSnapshot(input: {
  repoRoot: string;
  revision: string;
  relativePath: string;
}): Promise<SnapshotRead> {
  const snapshot = await createGitWorktreeAtRevision(input.repoRoot, input.revision);

  try {
    const filePath = path.join(snapshot.worktreeRoot, input.relativePath);
    const contents = await fs.readFile(filePath, "utf8");
    return { sha: snapshot.sha, worktreeRoot: snapshot.worktreeRoot, contents };
  } finally {
    await snapshot.cleanup();
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane git worktree helper", () => {
  it("creates detached worktrees for revisions and cleans them up", async () => {
    repoHandle = await createTempGitRepo();
    const targetPath = "notes/entry.txt";

    await repoHandle.writeFile(targetPath, "first\n");
    const firstSha = await repoHandle.commit("first commit");

    await repoHandle.writeFile(targetPath, "second\n");
    const secondSha = await repoHandle.commit("second commit");

    const firstSnapshot = await readFileFromSnapshot({
      repoRoot: repoHandle.repoDir,
      revision: "HEAD~1",
      relativePath: targetPath,
    });

    const secondSnapshot = await readFileFromSnapshot({
      repoRoot: repoHandle.repoDir,
      revision: "HEAD",
      relativePath: targetPath,
    });

    expect(firstSnapshot.contents).toBe("first\n");
    expect(firstSnapshot.sha).toBe(firstSha);
    expect(secondSnapshot.contents).toBe("second\n");
    expect(secondSnapshot.sha).toBe(secondSha);

    const worktreeList = await repoHandle.git(["worktree", "list"]);

    expect(worktreeList).not.toContain(firstSnapshot.worktreeRoot);
    expect(worktreeList).not.toContain(secondSnapshot.worktreeRoot);
  });
});
