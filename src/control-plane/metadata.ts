// Control plane model metadata helpers.
// Purpose: define metadata shape and compatibility checks for cached models.
// Assumes extractor versions are stable string identifiers updated with schema changes.

import { isoNow, readJsonFile, writeJsonFile } from "../core/utils.js";

export type ControlPlaneExtractorVersions = Record<string, string>;

export type ControlPlaneModelMetadata = {
  schema_version: number;
  extractor_versions: ControlPlaneExtractorVersions;
  built_at: string;
  base_sha: string;
  repo_root: string;
  model_hash?: string;
};

export type ControlPlaneMetadataCompatibility = {
  schemaVersion: number;
  extractorVersions: ControlPlaneExtractorVersions;
};

// =============================================================================
// METADATA HELPERS
// =============================================================================

export function createControlPlaneMetadata(input: {
  baseSha: string;
  repoRoot: string;
  schemaVersion: number;
  extractorVersions: ControlPlaneExtractorVersions;
  modelHash?: string;
}): ControlPlaneModelMetadata {
  return {
    schema_version: input.schemaVersion,
    extractor_versions: input.extractorVersions,
    built_at: isoNow(),
    base_sha: input.baseSha,
    repo_root: input.repoRoot,
    model_hash: input.modelHash,
  };
}

export function isMetadataCompatible(
  metadata: ControlPlaneModelMetadata,
  expected: ControlPlaneMetadataCompatibility,
): boolean {
  if (metadata.schema_version !== expected.schemaVersion) {
    return false;
  }

  return areExtractorVersionsEqual(metadata.extractor_versions, expected.extractorVersions);
}

export async function readControlPlaneMetadata(
  metadataPath: string,
): Promise<ControlPlaneModelMetadata> {
  return readJsonFile<ControlPlaneModelMetadata>(metadataPath);
}

export async function writeControlPlaneMetadata(
  metadataPath: string,
  metadata: ControlPlaneModelMetadata,
): Promise<void> {
  await writeJsonFile(metadataPath, metadata);
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function areExtractorVersionsEqual(
  left: ControlPlaneExtractorVersions,
  right: ControlPlaneExtractorVersions,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}
