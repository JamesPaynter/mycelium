// Control plane model loading helpers.
// Purpose: resolve cached models or build temporary snapshots for queries.
// Assumes callers handle error rendering for missing models.

import path from "node:path";

import { withControlPlaneModel } from "../query/at-revision.js";
import { ControlPlaneStore } from "../storage.js";

import { buildControlPlaneModel, getControlPlaneModelInfo } from "./build.js";
import type { ControlPlaneModel } from "./schema.js";

// =============================================================================
// TYPES
// =============================================================================

export type ControlPlaneModelQueryOptions = {
  repoRoot: string;
  baseSha: string | null;
  ref: string | null;
  at?: string | null;
  shouldBuild: boolean;
};

export type ControlPlaneModelQueryResult = {
  model: ControlPlaneModel;
  baseSha: string;
  repoRoot: string;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadControlPlaneModelForQuery(
  options: ControlPlaneModelQueryOptions,
): Promise<ControlPlaneModelQueryResult | null> {
  const repoRoot = path.resolve(options.repoRoot);
  const at = normalizeOptionalString(options.at);

  if (at) {
    if (!options.shouldBuild) {
      return null;
    }

    return withControlPlaneModel({ kind: "git-rev", repoRoot, rev: at }, async (model, ctx) => {
      if (!ctx.sha) {
        throw new Error("Resolved git revision missing SHA.");
      }

      return {
        model,
        baseSha: ctx.sha,
        repoRoot: ctx.repoRoot,
      };
    });
  }

  return loadStoredControlPlaneModel({
    repoRoot,
    baseSha: options.baseSha,
    ref: options.ref,
    shouldBuild: options.shouldBuild,
  });
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function loadStoredControlPlaneModel(input: {
  repoRoot: string;
  baseSha: string | null;
  ref: string | null;
  shouldBuild: boolean;
}): Promise<ControlPlaneModelQueryResult | null> {
  if (input.shouldBuild) {
    const buildResult = await buildControlPlaneModel({
      repoRoot: input.repoRoot,
      baseSha: input.baseSha,
      ref: input.ref,
    });
    const store = new ControlPlaneStore(input.repoRoot);
    const model = await store.readModel(buildResult.base_sha);
    return model
      ? {
          model,
          baseSha: buildResult.base_sha,
          repoRoot: input.repoRoot,
        }
      : null;
  }

  const info = await getControlPlaneModelInfo({
    repoRoot: input.repoRoot,
    baseSha: input.baseSha,
    ref: input.ref,
  });

  if (!info.exists) {
    return null;
  }

  const store = new ControlPlaneStore(input.repoRoot);
  const model = await store.readModel(info.base_sha);
  return model
    ? {
        model,
        baseSha: info.base_sha,
        repoRoot: input.repoRoot,
      }
    : null;
}

function normalizeOptionalString(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
