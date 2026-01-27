// Control plane derived scope integration.
// Purpose: derive write scopes from task manifests using control plane ownership data.
// Assumes component roots are repo-relative paths using forward slashes.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TaskManifest } from "../../core/task-manifest.js";
import { git } from "../../git/git.js";
import type { ControlPlaneModel } from "../model/schema.js";
import { resolveSurfacePatterns } from "../policy/surface-detect.js";
import type { SurfacePatternSet } from "../policy/types.js";

import {
  buildDerivedScopeContext,
  buildDerivedLocks,
  buildDerivedWritePaths,
  buildMissingOwnerNote,
  type DerivedScopeContext,
  dedupeAndSort,
  resolveComponentResourcesForFiles,
} from "./derived-scope-helpers.js";

export type DerivedScopeConfidence = "high" | "medium" | "low";

export type DerivedScopeReport = {
  task_id: string;
  task_name: string;
  derived_write_resources: string[];
  derived_write_paths?: string[];
  derived_locks: TaskManifest["locks"];
  confidence: DerivedScopeConfidence;
  notes: string[];
  manifest: {
    locks: TaskManifest["locks"];
    files: TaskManifest["files"];
  };
};

export type DerivedScopeSnapshot = {
  snapshotPath: string;
  release: () => Promise<void>;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function createDerivedScopeSnapshot(input: {
  repoPath: string;
  baseSha: string;
}): Promise<DerivedScopeSnapshot> {
  const repoRoot = path.resolve(input.repoPath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-derived-scope-"));
  const snapshotPath = path.join(tempRoot, "repo");

  try {
    await git(repoRoot, ["worktree", "add", "--detach", snapshotPath, input.baseSha]);
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return {
    snapshotPath,
    release: async () => {
      if (released) return;
      released = true;

      try {
        await git(repoRoot, ["worktree", "remove", "--force", snapshotPath]);
      } catch {
        // Ignore cleanup failures to avoid masking the primary flow.
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function deriveTaskWriteScopeReport(input: {
  manifest: TaskManifest;
  model: ControlPlaneModel;
  snapshotPath: string;
  componentResourcePrefix: string;
  fallbackResource: string;
  surfaceLocksEnabled?: boolean;
  surfacePatterns?: SurfacePatternSet;
}): Promise<DerivedScopeReport> {
  const surfaceLocksEnabled = input.surfaceLocksEnabled ?? false;
  const surfacePatterns = input.surfacePatterns ?? resolveSurfacePatterns();

  const derived = await deriveTaskWriteScope({
    manifest: input.manifest,
    model: input.model,
    snapshotPath: input.snapshotPath,
    componentResourcePrefix: input.componentResourcePrefix,
    fallbackResource: input.fallbackResource,
    surfaceLocksEnabled,
    surfacePatterns,
  });

  return {
    task_id: input.manifest.id,
    task_name: input.manifest.name,
    derived_write_resources: derived.derivedWriteResources,
    derived_write_paths: derived.derivedWritePaths,
    derived_locks: derived.derivedLocks,
    confidence: derived.confidence,
    notes: derived.notes,
    manifest: {
      locks: input.manifest.locks,
      files: input.manifest.files,
    },
  };
}

// =============================================================================
// INTERNALS
// =============================================================================

type DerivedWriteScope = {
  derivedWriteResources: string[];
  derivedWritePaths?: string[];
  derivedLocks: TaskManifest["locks"];
  confidence: DerivedScopeConfidence;
  notes: string[];
};

async function deriveTaskWriteScope(input: {
  manifest: TaskManifest;
  model: ControlPlaneModel;
  snapshotPath: string;
  componentResourcePrefix: string;
  fallbackResource: string;
  surfaceLocksEnabled: boolean;
  surfacePatterns: SurfacePatternSet;
}): Promise<DerivedWriteScope> {
  const context = await buildDerivedScopeContext(input);

  const componentScope = deriveScopeFromComponentLocks(context);
  if (componentScope) {
    return componentScope;
  }

  const fallbackScope = deriveScopeFromFallback(context);
  if (fallbackScope) {
    return fallbackScope;
  }

  return deriveScopeFromExpandedFiles(context);
}

function deriveScopeFromComponentLocks(context: DerivedScopeContext): DerivedWriteScope | null {
  if (context.componentLocks.length === 0) {
    return null;
  }

  const derivedWriteResources = dedupeAndSort(context.componentLocks);
  const derivedWritePaths = buildDerivedWritePaths({
    resources: derivedWriteResources,
    model: context.model,
    componentResourcePrefix: context.componentResourcePrefix,
    notes: context.notes,
  });

  return {
    derivedWriteResources,
    derivedWritePaths,
    derivedLocks: buildDerivedLocks({
      derivedWriteResources,
      surfaceLockComponents: context.surfaceLockComponents,
    }),
    confidence: "high",
    notes: context.notes,
  };
}

function deriveScopeFromFallback(context: DerivedScopeContext): DerivedWriteScope | null {
  if (context.expandedFiles.length > 0) {
    return null;
  }

  context.notes.push(
    context.writeGlobs.length === 0
      ? `No manifest write globs provided; widened to ${context.fallbackResource}.`
      : `No files matched manifest write globs; widened to ${context.fallbackResource}.`,
  );

  const fallbackResources = context.fallbackResource ? [context.fallbackResource] : [];

  return {
    derivedWriteResources: fallbackResources,
    derivedLocks: buildDerivedLocks({
      derivedWriteResources: fallbackResources,
      surfaceLockComponents: context.surfaceLockComponents,
    }),
    confidence: "low",
    notes: context.notes,
  };
}

function deriveScopeFromExpandedFiles(context: DerivedScopeContext): DerivedWriteScope {
  const { resources, missingOwners } = resolveComponentResourcesForFiles({
    files: context.expandedFiles,
    model: context.model,
    componentResourcePrefix: context.componentResourcePrefix,
  });

  const shouldFallback = missingOwners.length > 0 || resources.length === 0;
  const derivedWriteResources = dedupeAndSort(
    shouldFallback && context.fallbackResource
      ? [...resources, context.fallbackResource]
      : resources,
  );

  const derivedWritePaths = buildDerivedWritePaths({
    resources: derivedWriteResources,
    model: context.model,
    componentResourcePrefix: context.componentResourcePrefix,
    notes: context.notes,
  });

  if (missingOwners.length > 0 && context.fallbackResource) {
    context.notes.push(buildMissingOwnerNote(missingOwners, context.fallbackResource));
  }

  if (resources.length === 0 && context.fallbackResource && missingOwners.length === 0) {
    context.notes.push(`No component owners resolved; widened to ${context.fallbackResource}.`);
  }

  return {
    derivedWriteResources,
    derivedWritePaths,
    derivedLocks: buildDerivedLocks({
      derivedWriteResources,
      surfaceLockComponents: context.surfaceLockComponents,
    }),
    confidence: shouldFallback ? "low" : "medium",
    notes: context.notes,
  };
}
