// UI code graph snapshot helpers.
// Purpose: load control-plane model artifacts and compute component growth stats for the UI map.
// Assumes control-plane models live under <repo>/.mycelium/control-plane/models/<base_sha>.

import path from "node:path";

import type { RunState } from "../core/state.js";

import {
  computeRunQuality,
  ensureRepoPath,
  getComponentStats,
  isValidSha,
  normalizeComponents,
  normalizeDeps,
  normalizeSha,
  readControlPlaneModel,
  resolveBaseSha,
} from "./code-graph-helpers.js";
import type { CodeGraphSnapshotResult } from "./code-graph-types.js";

export type {
  CodeGraphComponent,
  CodeGraphDependency,
  CodeGraphError,
  CodeGraphErrorCode,
  CodeGraphSnapshot,
  CodeGraphSnapshotResult,
  ComponentStats,
} from "./code-graph-types.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadCodeGraphSnapshot(params: {
  state: RunState;
  baseShaOverride?: string | null;
}): Promise<CodeGraphSnapshotResult> {
  const repoPath = path.resolve(params.state.repo_path);
  const repoExists = await ensureRepoPath(repoPath);
  if (!repoExists) {
    return {
      ok: false,
      error: {
        code: "REPO_NOT_FOUND",
        message: `Repo path not found: ${repoPath}.`,
      },
    };
  }

  const baseSha = await resolveBaseSha({
    repoPath,
    baseShaOverride: params.baseShaOverride ?? null,
    stateBaseSha: params.state.control_plane?.base_sha ?? null,
    mainBranch: params.state.main_branch,
  });

  if (!baseSha) {
    return {
      ok: false,
      error: {
        code: "BASE_SHA_RESOLUTION_FAILED",
        message: "Unable to resolve base SHA for the run.",
        hint: "Provide ?baseSha=<sha> or ensure the repo has git history.",
      },
    };
  }

  const normalizedSha = normalizeSha(baseSha);
  if (!isValidSha(normalizedSha)) {
    return {
      ok: false,
      error: {
        code: "INVALID_BASE_SHA",
        message: `Invalid base SHA: ${baseSha}.`,
      },
    };
  }

  const modelResult = await readControlPlaneModel(repoPath, normalizedSha);
  if (!modelResult.ok) {
    if (modelResult.reason === "not_found") {
      return {
        ok: false,
        error: {
          code: "MODEL_NOT_FOUND",
          message: `No control graph model found for base_sha ${normalizedSha}.`,
          hint: `Run: mycelium cg build --base-sha ${normalizedSha}`,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "INVALID_BASE_SHA",
        message: `Invalid base SHA: ${normalizedSha}.`,
      },
    };
  }

  const components = normalizeComponents(modelResult.model.components);
  const deps = normalizeDeps(modelResult.model);
  const stats = await getComponentStats({
    repoPath,
    baseSha: normalizedSha,
    modelMtimeMs: modelResult.modelMtimeMs,
    components,
  });

  return {
    ok: true,
    result: {
      base_sha: normalizedSha,
      model: {
        schema_version: modelResult.metadata?.schema_version ?? null,
        built_at: modelResult.metadata?.built_at ?? null,
      },
      components,
      deps,
      stats,
      run_quality: computeRunQuality(params.state),
    },
  };
}
