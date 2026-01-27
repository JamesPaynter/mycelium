import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ControlPlaneModelMetadata } from "../control-plane/metadata.js";
import type { ControlPlaneModel } from "../control-plane/model/schema.js";
import { isGitRepo, readJsonFile } from "../core/utils.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// TYPES
// =============================================================================

type ModelReadResult =
  | {
      ok: true;
      model: ControlPlaneModel;
      metadata: ControlPlaneModelMetadata | null;
      modelMtimeMs: number;
    }
  | { ok: false; reason: "not_found" | "invalid_path" };

// =============================================================================
// BASE SHA RESOLUTION
// =============================================================================

export async function resolveBaseSha(params: {
  repoPath: string;
  baseShaOverride: string | null;
  stateBaseSha: string | null;
  mainBranch: string;
}): Promise<string | null> {
  if (params.baseShaOverride && params.baseShaOverride.trim()) {
    return params.baseShaOverride.trim();
  }

  if (params.stateBaseSha && params.stateBaseSha.trim()) {
    return params.stateBaseSha.trim();
  }

  const fromBranch = await resolveGitSha(params.repoPath, params.mainBranch);
  if (fromBranch) {
    return fromBranch;
  }

  return resolveGitSha(params.repoPath, "HEAD");
}

async function resolveGitSha(repoPath: string, ref: string): Promise<string | null> {
  if (!isGitRepo(repoPath)) {
    return null;
  }

  try {
    const result = await execFileAsync("git", ["rev-parse", ref], { cwd: repoPath });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

// =============================================================================
// MODEL LOADING
// =============================================================================

export async function readControlPlaneModel(
  repoPath: string,
  baseSha: string,
): Promise<ModelReadResult> {
  const modelsRoot = path.join(repoPath, ".mycelium", "control-plane", "models");
  const modelDir = path.resolve(modelsRoot, baseSha);
  const relative = path.relative(modelsRoot, modelDir);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "invalid_path" };
  }

  const modelPath = path.join(modelDir, "model.json");
  const metadataPath = path.join(modelDir, "metadata.json");

  const stat = await fs.stat(modelPath).catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!stat || !stat.isFile()) {
    return { ok: false, reason: "not_found" };
  }

  const model = await readJsonFile<ControlPlaneModel>(modelPath);
  const metadata = await readJsonFile<ControlPlaneModelMetadata>(metadataPath).catch(() => null);

  return {
    ok: true,
    model,
    metadata,
    modelMtimeMs: stat.mtimeMs,
  };
}

// =============================================================================
// UTILITIES
// =============================================================================

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}
