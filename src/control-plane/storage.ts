// Control plane model storage layer.
// Purpose: resolve cache paths, read/write model artifacts, and guard builds with a lock.
// Assumes the store lives under <repo>/.mycelium/control-plane/models.

import fs from "node:fs";
import path from "node:path";

import { ensureDir, isoNow, pathExists, readJsonFile, writeJsonFile } from "../core/utils.js";

import type { ControlPlaneModelMetadata } from "./metadata.js";
import { readControlPlaneMetadata, writeControlPlaneMetadata } from "./metadata.js";
import type { ControlPlaneModel } from "./model/schema.js";

export type ControlPlaneBuildLock = {
  lockPath: string;
  release: () => Promise<void>;
};

export class ControlPlaneBuildLockError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Control plane model build lock already held: ${lockPath}`);
    this.name = "ControlPlaneBuildLockError";
  }
}

export class ControlPlaneStore {
  private readonly repoRoot: string;
  private readonly modelsRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.modelsRoot = resolveModelsRoot(this.repoRoot);
  }

  getModelDir(baseSha: string): string {
    return path.join(this.modelsRoot, baseSha);
  }

  getMetadataPath(baseSha: string): string {
    return path.join(this.getModelDir(baseSha), "metadata.json");
  }

  getModelPath(baseSha: string): string {
    return path.join(this.getModelDir(baseSha), "model.json");
  }

  getLockPath(baseSha: string): string {
    return path.join(this.getModelDir(baseSha), "build.lock");
  }

  async readMetadata(baseSha: string): Promise<ControlPlaneModelMetadata | null> {
    const metadataPath = this.getMetadataPath(baseSha);
    if (!(await pathExists(metadataPath))) {
      return null;
    }
    return readControlPlaneMetadata(metadataPath);
  }

  async readModel(baseSha: string): Promise<ControlPlaneModel | null> {
    const modelPath = this.getModelPath(baseSha);
    if (!(await pathExists(modelPath))) {
      return null;
    }
    return readJsonFile<ControlPlaneModel>(modelPath);
  }

  async hasModelFile(baseSha: string): Promise<boolean> {
    return pathExists(this.getModelPath(baseSha));
  }

  async modelExists(baseSha: string): Promise<boolean> {
    const [metadataExists, modelExists] = await Promise.all([
      pathExists(this.getMetadataPath(baseSha)),
      pathExists(this.getModelPath(baseSha)),
    ]);
    return metadataExists && modelExists;
  }

  async writeModel(
    baseSha: string,
    model: ControlPlaneModel,
    metadata: ControlPlaneModelMetadata,
  ): Promise<void> {
    const modelDir = this.getModelDir(baseSha);
    await ensureDir(modelDir);

    await writeJsonFile(this.getModelPath(baseSha), model);
    await writeControlPlaneMetadata(this.getMetadataPath(baseSha), metadata);
  }

  async acquireBuildLock(baseSha: string): Promise<ControlPlaneBuildLock> {
    const lockPath = this.getLockPath(baseSha);
    await ensureDir(path.dirname(lockPath));

    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(lockPath, "wx");
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new ControlPlaneBuildLockError(lockPath);
      }
      throw error;
    }

    try {
      const payload = JSON.stringify({ pid: process.pid, acquired_at: isoNow() }) + "\n";
      await handle.writeFile(payload, "utf8");
    } catch (error) {
      await handle.close();
      await safeUnlink(lockPath);
      throw error;
    }

    return {
      lockPath,
      release: async () => {
        if (handle) {
          await handle.close();
        }
        await safeUnlink(lockPath);
      },
    };
  }
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function resolveModelsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".mycelium", "control-plane", "models");
}

function isFileExistsError(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }
}

function isFileMissingError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if (!("code" in error)) {
    return undefined;
  }

  const withCode = error as { code?: unknown };
  return typeof withCode.code === "string" ? withCode.code : undefined;
}
