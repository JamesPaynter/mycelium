// Surface change detector.
// Purpose: flag high-risk file changes that should widen policy enforcement.

import path from "node:path";

import { minimatch } from "minimatch";

import { resolveOwnershipForPath } from "../extract/ownership.js";
import type { ControlPlaneModel } from "../model/schema.js";
import type {
  SurfaceChangeCategory,
  SurfaceChangeDetection,
  SurfacePatternConfig,
  SurfacePatternSet,
} from "./types.js";

const SURFACE_CATEGORY_ORDER: SurfaceChangeCategory[] = [
  "contract",
  "config",
  "migration",
  "public-entrypoint",
];

export const DEFAULT_SURFACE_PATTERNS: SurfacePatternSet = {
  contract: ["**/openapi.*", "**/*.proto", "**/asyncapi.*", "**/*.graphql", "**/schema.*"],
  config: [
    ".env*",
    "**/.env*",
    "**/config/**",
    "**/*config*.*",
    "**/k8s/**",
    "**/kubernetes/**",
    "**/helm/**",
    "**/values*.yaml",
    "**/values*.yml",
  ],
  migration: ["**/migrations/**", "**/*migration*/**"],
  "public-entrypoint": ["**/index.ts", "**/package.json"],
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function resolveSurfacePatterns(overrides?: SurfacePatternConfig): SurfacePatternSet {
  return {
    contract: normalizePatternList(overrides?.contract, DEFAULT_SURFACE_PATTERNS.contract),
    config: normalizePatternList(overrides?.config, DEFAULT_SURFACE_PATTERNS.config),
    migration: normalizePatternList(overrides?.migration, DEFAULT_SURFACE_PATTERNS.migration),
    "public-entrypoint": normalizePatternList(
      overrides?.["public-entrypoint"],
      DEFAULT_SURFACE_PATTERNS["public-entrypoint"],
    ),
  };
}

export function detectSurfaceChanges(
  changedFiles: string[],
  patterns: SurfacePatternConfig = DEFAULT_SURFACE_PATTERNS,
): SurfaceChangeDetection {
  const resolvedPatterns = resolveSurfacePatterns(patterns);
  const matchesByCategory = initializeMatchBuckets();

  for (const file of dedupeList(changedFiles)) {
    const normalizedFile = toPosixPath(file);

    for (const category of SURFACE_CATEGORY_ORDER) {
      const categoryPatterns = resolvedPatterns[category];
      if (categoryPatterns.length === 0) {
        continue;
      }

      if (matchesAnyPattern(normalizedFile, categoryPatterns)) {
        matchesByCategory.get(category)?.add(normalizedFile);
      }
    }
  }

  const matchedFiles: SurfaceChangeDetection["matched_files"] = {};
  const categories: SurfaceChangeCategory[] = [];

  for (const category of SURFACE_CATEGORY_ORDER) {
    const files = matchesByCategory.get(category);
    if (!files || files.size === 0) {
      continue;
    }

    const sorted = Array.from(files).sort();
    matchedFiles[category] = sorted;
    categories.push(category);
  }

  return {
    is_surface_change: categories.length > 0,
    categories,
    matched_files: matchedFiles,
  };
}

// =============================================================================
// COMPONENT ASSOCIATION
// =============================================================================

export function associateSurfaceChangesWithComponents(input: {
  detection: SurfaceChangeDetection;
  model: ControlPlaneModel;
}): SurfaceChangeDetection {
  if (!input.detection.is_surface_change) {
    return input.detection;
  }

  const matchedComponents = new Set<string>();
  const matchedByCategory: Partial<Record<SurfaceChangeCategory, string[]>> = {};

  for (const category of input.detection.categories) {
    const files = input.detection.matched_files[category];
    if (!files || files.length === 0) {
      continue;
    }

    const categoryComponents = new Set<string>();
    for (const file of files) {
      const match = resolveOwnershipForPath(input.model.ownership, input.model.components, file);
      if (!match.owner) {
        continue;
      }

      const componentId = match.owner.component.id;
      categoryComponents.add(componentId);
      matchedComponents.add(componentId);
    }

    if (categoryComponents.size > 0) {
      matchedByCategory[category] = Array.from(categoryComponents).sort();
    }
  }

  if (matchedComponents.size === 0) {
    return input.detection;
  }

  return {
    ...input.detection,
    matched_components: Array.from(matchedComponents).sort(),
    matched_components_by_category: matchedByCategory,
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function initializeMatchBuckets(): Map<SurfaceChangeCategory, Set<string>> {
  const buckets = new Map<SurfaceChangeCategory, Set<string>>();
  for (const category of SURFACE_CATEGORY_ORDER) {
    buckets.set(category, new Set());
  }
  return buckets;
}

function normalizePatternList(overrides: string[] | undefined, defaults: string[]): string[] {
  if (overrides === undefined) {
    return defaults;
  }

  return dedupeList(
    overrides.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0),
  ).sort();
}

function matchesAnyPattern(file: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(file, toPosixPath(pattern), { dot: true, nocase: false })) {
      return true;
    }
  }

  return false;
}

function dedupeList(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
