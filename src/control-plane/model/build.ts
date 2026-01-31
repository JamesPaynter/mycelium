// Control plane model build orchestration.
// Purpose: resolve revisions, coordinate locks, and populate the file-backed cache.
// Assumes extractor versions track compatibility for stored artifacts.

import crypto from "node:crypto";
import path from "node:path";

import { extractComponents } from "../extract/components.js";
import { buildOwnershipIndex } from "../extract/ownership.js";
import { extractTypeScriptSymbolDefinitions } from "../extract/symbols-ts/index.js";
import { resolveBaseSha } from "../git.js";
import {
  createControlPlaneMetadata,
  isMetadataCompatible,
  type ControlPlaneExtractorVersions,
  type ControlPlaneModelMetadata,
} from "../metadata.js";
import { ControlPlaneStore } from "../storage.js";

import { buildControlPlaneDependencies } from "./deps.js";
import { createEmptyModel, MODEL_SCHEMA_VERSION, type ControlPlaneModel } from "./schema.js";

export type ControlPlaneBuildOptions = {
  repoRoot: string;
  baseSha?: string | null;
  ref?: string | null;
  force?: boolean;
};

export type ControlPlaneBuildResult = {
  base_sha: string;
  cache_dir: string;
  metadata: ControlPlaneModelMetadata;
  reused: boolean;
};

export type ControlPlaneModelInfo = {
  base_sha: string;
  cache_dir: string;
  exists: boolean;
  metadata: ControlPlaneModelMetadata | null;
};

export type ControlPlaneModelSnapshot = {
  base_sha: string;
  model: ControlPlaneModel;
  metadata: ControlPlaneModelMetadata;
};

export type ControlPlaneSnapshotOptions = {
  repoRoot: string;
  baseSha?: string | null;
  ref?: string | null;
};

// =============================================================================
// ERRORS
// =============================================================================

export class ControlPlaneModelBuildError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ControlPlaneModelBuildError";
  }
}

const EXTRACTOR_VERSIONS: ControlPlaneExtractorVersions = {
  components: "v1",
  ownership: "v1",
  deps: "v1",
  symbols_ts: "v1",
};

// =============================================================================
// BUILD ORCHESTRATION
// =============================================================================

export async function buildControlPlaneModel(
  options: ControlPlaneBuildOptions,
): Promise<ControlPlaneBuildResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const baseSha = await resolveBaseSha({
    repoRoot,
    baseSha: options.baseSha ?? null,
    ref: options.ref ?? null,
  });

  const store = new ControlPlaneStore(repoRoot);
  const lock = await store.acquireBuildLock(baseSha);

  try {
    const [existingMetadata, modelFileExists] = await Promise.all([
      store.readMetadata(baseSha),
      store.hasModelFile(baseSha),
    ]);

    const canReuse =
      !options.force &&
      existingMetadata !== null &&
      modelFileExists &&
      isMetadataCompatible(existingMetadata, {
        schemaVersion: MODEL_SCHEMA_VERSION,
        extractorVersions: EXTRACTOR_VERSIONS,
      });

    if (canReuse && existingMetadata) {
      return {
        base_sha: baseSha,
        cache_dir: store.getModelDir(baseSha),
        metadata: existingMetadata,
        reused: true,
      };
    }

    const { model, metadata } = await buildControlPlaneModelArtifacts({
      repoRoot,
      baseSha,
    });

    await store.writeModel(baseSha, model, metadata);

    return {
      base_sha: baseSha,
      cache_dir: store.getModelDir(baseSha),
      metadata,
      reused: false,
    };
  } catch (error) {
    throw wrapBuildError(error);
  } finally {
    await lock.release();
  }
}

export async function buildControlPlaneModelSnapshot(
  options: ControlPlaneSnapshotOptions,
): Promise<ControlPlaneModelSnapshot> {
  const repoRoot = path.resolve(options.repoRoot);
  const baseSha = await resolveBaseSha({
    repoRoot,
    baseSha: options.baseSha ?? null,
    ref: options.ref ?? null,
  });

  try {
    const { model, metadata } = await buildControlPlaneModelArtifacts({
      repoRoot,
      baseSha,
    });

    return {
      base_sha: baseSha,
      model,
      metadata,
    };
  } catch (error) {
    throw wrapBuildError(error);
  }
}

export async function getControlPlaneModelInfo(
  options: Omit<ControlPlaneBuildOptions, "force">,
): Promise<ControlPlaneModelInfo> {
  const repoRoot = path.resolve(options.repoRoot);
  const baseSha = await resolveBaseSha({
    repoRoot,
    baseSha: options.baseSha ?? null,
    ref: options.ref ?? null,
  });

  const store = new ControlPlaneStore(repoRoot);
  const [metadata, modelFileExists] = await Promise.all([
    store.readMetadata(baseSha),
    store.hasModelFile(baseSha),
  ]);

  const exists = metadata !== null && modelFileExists;

  return {
    base_sha: baseSha,
    cache_dir: store.getModelDir(baseSha),
    exists,
    metadata: exists ? metadata : null,
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function buildControlPlaneModelArtifacts(input: {
  repoRoot: string;
  baseSha: string;
}): Promise<{ model: ControlPlaneModel; metadata: ControlPlaneModelMetadata }> {
  const { components } = await extractComponents(input.repoRoot);
  const ownership = buildOwnershipIndex(components);
  const deps = await buildControlPlaneDependencies({ repoRoot: input.repoRoot, components });
  const symbolResult = await extractTypeScriptSymbolDefinitions({
    repoRoot: input.repoRoot,
    components,
    ownership,
  });

  const model = createEmptyModel();
  model.components = components;
  model.ownership = ownership;
  model.deps = deps;
  model.symbols_ts = { definitions: symbolResult.definitions };
  emitSymbolWarnings(symbolResult.warnings);
  const modelHash = hashModel(model);
  const metadata = createControlPlaneMetadata({
    baseSha: input.baseSha,
    repoRoot: input.repoRoot,
    schemaVersion: MODEL_SCHEMA_VERSION,
    extractorVersions: EXTRACTOR_VERSIONS,
    modelHash,
  });

  return { model, metadata };
}

function hashModel(model: ControlPlaneModel): string {
  const payload = JSON.stringify(model, null, 2) + "\n";
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function wrapBuildError(error: unknown): ControlPlaneModelBuildError {
  if (error instanceof ControlPlaneModelBuildError) {
    return error;
  }

  return new ControlPlaneModelBuildError("Control plane model build failed.", error);
}

function emitSymbolWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    console.warn(`[control-graph] ${warning}`);
  }
}
