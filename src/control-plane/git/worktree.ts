// Control plane git worktree helper.
// Purpose: create detached worktrees for control graph queries.
// Assumes the target repo is a valid git checkout.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "../../git/git.js";

// =============================================================================
// TYPES
// =============================================================================

export type GitWorktreeSnapshot = {
  sha: string;
  worktreeRoot: string;
  cleanup: () => Promise<void>;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function createGitWorktreeAtRevision(
  repoRoot: string,
  revision: string,
): Promise<GitWorktreeSnapshot> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedSha = await resolveRevisionSha(resolvedRepoRoot, revision);
  const { tempRoot, worktreeRoot } = await createTempWorktreeRoot(resolvedSha);

  try {
    await git(resolvedRepoRoot, ["worktree", "add", "--detach", worktreeRoot, resolvedSha]);
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    sha: resolvedSha,
    worktreeRoot,
    cleanup: buildWorktreeCleanup({
      repoRoot: resolvedRepoRoot,
      tempRoot,
      worktreeRoot,
    }),
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function resolveRevisionSha(repoRoot: string, revision: string): Promise<string> {
  const trimmedRevision = revision.trim();
  if (trimmedRevision.length === 0) {
    throw new Error("Revision must be non-empty.");
  }

  const result = await git(repoRoot, ["rev-parse", trimmedRevision]);
  return result.stdout.trim();
}

async function createTempWorktreeRoot(
  resolvedSha: string,
): Promise<{ tempRoot: string; worktreeRoot: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `mycelium-cg-worktree-${resolvedSha}-`));
  const worktreeRoot = path.join(tempRoot, "repo");
  return { tempRoot, worktreeRoot };
}

function buildWorktreeCleanup(input: {
  repoRoot: string;
  tempRoot: string;
  worktreeRoot: string;
}): () => Promise<void> {
  let hasCleanedUp = false;

  return async () => {
    if (hasCleanedUp) return;
    hasCleanedUp = true;

    // Best-effort cleanup keeps the primary failure intact.
    await runBestEffort(async () => {
      await git(input.repoRoot, ["worktree", "remove", "--force", input.worktreeRoot]);
    });
    await runBestEffort(async () => {
      await git(input.repoRoot, ["worktree", "prune"]);
    });
    await runBestEffort(async () => {
      await fs.rm(input.tempRoot, { recursive: true, force: true });
    });
  };
}

async function runBestEffort(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    // Ignore cleanup failures.
  }
}
