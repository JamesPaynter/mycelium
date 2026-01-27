import path from "node:path";

import fg from "fast-glob";

import type { TaskManifest } from "../../core/task-manifest.js";
import { resolveOwnershipForPath } from "../extract/ownership.js";
import type { ControlPlaneModel } from "../model/schema.js";
import {
  associateSurfaceChangesWithComponents,
  detectSurfaceChanges,
} from "../policy/surface-detect.js";
import type { SurfacePatternSet } from "../policy/types.js";

const SURFACE_LOCK_PREFIX = "surface:";

// =============================================================================
// DERIVATION CONTEXT
// =============================================================================

export type DerivedScopeContext = {
  fallbackResource: string;
  notes: string[];
  componentLocks: string[];
  writeGlobs: string[];
  expandedFiles: string[];
  surfaceLockComponents: string[];
  model: ControlPlaneModel;
  componentResourcePrefix: string;
};

export async function buildDerivedScopeContext(input: {
  manifest: TaskManifest;
  model: ControlPlaneModel;
  snapshotPath: string;
  componentResourcePrefix: string;
  fallbackResource: string;
  surfaceLocksEnabled: boolean;
  surfacePatterns: SurfacePatternSet;
}): Promise<DerivedScopeContext> {
  const fallbackResource = normalizeFallbackResource(input.fallbackResource);
  const notes: string[] = [];
  const componentLocks = findComponentLocks(
    input.manifest.locks?.writes ?? [],
    input.componentResourcePrefix,
  );
  const writeGlobs = normalizeStringList(input.manifest.files?.writes ?? []);
  const expandedFiles = await resolveExpandedFiles({
    writeGlobs,
    snapshotPath: input.snapshotPath,
    shouldExpand: shouldExpandWriteGlobs(writeGlobs, componentLocks, input.surfaceLocksEnabled),
  });
  const surfaceLockComponents = resolveSurfaceLockComponents({
    expandedFiles,
    model: input.model,
    surfaceLocksEnabled: input.surfaceLocksEnabled,
    surfacePatterns: input.surfacePatterns,
  });

  return {
    fallbackResource,
    notes,
    componentLocks,
    writeGlobs,
    expandedFiles,
    surfaceLockComponents,
    model: input.model,
    componentResourcePrefix: input.componentResourcePrefix,
  };
}

function shouldExpandWriteGlobs(
  writeGlobs: string[],
  componentLocks: string[],
  surfaceLocksEnabled: boolean,
): boolean {
  return writeGlobs.length > 0 && (componentLocks.length === 0 || surfaceLocksEnabled);
}

async function resolveExpandedFiles(input: {
  writeGlobs: string[];
  snapshotPath: string;
  shouldExpand: boolean;
}): Promise<string[]> {
  if (!input.shouldExpand) {
    return [];
  }

  return expandWriteGlobs(input.writeGlobs, input.snapshotPath);
}

// =============================================================================
// LOCK RESOLUTION
// =============================================================================

export function findComponentLocks(locks: string[], prefix: string): string[] {
  return locks.filter((lock) => lock.startsWith(prefix));
}

export async function expandWriteGlobs(globs: string[], snapshotPath: string): Promise<string[]> {
  if (globs.length === 0) {
    return [];
  }

  const matches = await fg(globs, {
    cwd: snapshotPath,
    dot: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
  });

  return matches.map(normalizeRepoPath).sort();
}

export function resolveComponentResourcesForFiles(input: {
  files: string[];
  model: ControlPlaneModel;
  componentResourcePrefix: string;
}): { resources: string[]; missingOwners: string[] } {
  const resources = new Set<string>();
  const missingOwners: string[] = [];

  for (const file of input.files) {
    const match = resolveOwnershipForPath(input.model.ownership, input.model.components, file);
    if (!match.owner) {
      missingOwners.push(file);
      continue;
    }

    resources.add(`${input.componentResourcePrefix}${match.owner.component.id}`);
  }

  return { resources: Array.from(resources).sort(), missingOwners };
}

// =============================================================================
// SURFACE LOCKS
// =============================================================================

export function resolveSurfaceLockComponents(input: {
  expandedFiles: string[];
  model: ControlPlaneModel;
  surfaceLocksEnabled: boolean;
  surfacePatterns: SurfacePatternSet;
}): string[] {
  if (!input.surfaceLocksEnabled || input.expandedFiles.length === 0) {
    return [];
  }

  const detection = detectSurfaceChanges(input.expandedFiles, input.surfacePatterns);
  if (!detection.is_surface_change) {
    return [];
  }

  const associated = associateSurfaceChangesWithComponents({
    detection,
    model: input.model,
  });

  return associated.matched_components ?? [];
}

export function buildDerivedLocks(input: {
  derivedWriteResources: string[];
  surfaceLockComponents: string[];
}): TaskManifest["locks"] {
  const surfaceLocks = buildSurfaceLockResources(input.surfaceLockComponents);
  return {
    reads: [],
    writes: dedupeAndSort([...input.derivedWriteResources, ...surfaceLocks]),
  };
}

function buildSurfaceLockResources(components: string[]): string[] {
  return components.map((component) => `${SURFACE_LOCK_PREFIX}${component}`);
}

// =============================================================================
// DERIVED PATHS
// =============================================================================

export function buildDerivedWritePaths(input: {
  resources: string[];
  model: ControlPlaneModel;
  componentResourcePrefix: string;
  notes: string[];
}): string[] | undefined {
  const componentsById = new Map(
    input.model.components.map((component) => [component.id, component]),
  );
  const patterns = new Set<string>();
  const missingComponents: string[] = [];

  for (const resource of input.resources) {
    if (!resource.startsWith(input.componentResourcePrefix)) {
      continue;
    }
    const componentId = resource.slice(input.componentResourcePrefix.length);
    const component = componentsById.get(componentId);
    if (!component) {
      missingComponents.push(resource);
      continue;
    }

    for (const pattern of buildComponentPathPatterns(component.roots)) {
      patterns.add(pattern);
    }
  }

  if (missingComponents.length > 0) {
    input.notes.push(
      `Component resources missing from control graph model: ${missingComponents.join(", ")}`,
    );
  }

  return patterns.size > 0 ? Array.from(patterns).sort() : undefined;
}

function buildComponentPathPatterns(roots: string[]): string[] {
  const patterns = new Set<string>();

  for (const rawRoot of roots) {
    const normalized = normalizeRepoPath(rawRoot);
    if (!normalized) {
      patterns.add("**/*");
      continue;
    }

    const pattern = normalized.includes("*") ? normalized : `${normalized}/**`;
    patterns.add(pattern);
  }

  if (patterns.size === 0) {
    patterns.add("**/*");
  }

  return Array.from(patterns).sort();
}

// =============================================================================
// NORMALIZATION
// =============================================================================

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}

export function normalizeFallbackResource(resource: string): string {
  const trimmed = resource.trim();
  return trimmed.length > 0 ? trimmed : "repo-root";
}

export function normalizeStringList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

export function dedupeAndSort(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

// =============================================================================
// MESSAGES
// =============================================================================

export function buildMissingOwnerNote(files: string[], fallbackResource: string): string {
  const maxSamples = 3;
  const samples = files.slice(0, maxSamples);
  const suffix = files.length > maxSamples ? ` (+${files.length - maxSamples} more)` : "";
  return `Missing ownership for ${files.length} file(s); widened to ${fallbackResource}. ${samples.join(
    ", ",
  )}${suffix}`;
}
