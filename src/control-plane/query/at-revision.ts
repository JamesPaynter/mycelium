// Control plane time-aware model loader.
// Purpose: load model snapshots at HEAD or a specific git revision.
// Assumes repoRoot points at a valid git checkout.

import path from "node:path";

import { withGitWorktreeAtRevision } from "../git/worktree.js";
import { buildControlPlaneModelSnapshot } from "../model/build.js";
import type { ControlPlaneModel } from "../model/schema.js";

// =============================================================================
// TYPES
// =============================================================================

export type ModelSource =
  | { kind: "head"; repoRoot: string }
  | { kind: "git-rev"; repoRoot: string; rev: string };

export type ControlPlaneModelContext = {
  repoRoot: string;
  sha?: string;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function withControlPlaneModel<T>(
  source: ModelSource,
  fn: (model: ControlPlaneModel, ctx: ControlPlaneModelContext) => Promise<T>,
): Promise<T> {
  const repoRoot = path.resolve(source.repoRoot);

  if (source.kind === "head") {
    const snapshot = await buildControlPlaneModelSnapshot({ repoRoot });
    return fn(snapshot.model, { repoRoot, sha: snapshot.base_sha });
  }

  return withGitWorktreeAtRevision(repoRoot, source.rev, async (snapshot) => {
    const modelSnapshot = await buildControlPlaneModelSnapshot({
      repoRoot: snapshot.worktreeRoot,
      baseSha: snapshot.sha,
    });

    return fn(modelSnapshot.model, {
      repoRoot: snapshot.worktreeRoot,
      sha: modelSnapshot.base_sha,
    });
  });
}
