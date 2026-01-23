// Control plane derived scope integration.
// Purpose: derive write scopes from task manifests using control plane ownership data.
// Assumes component roots are repo-relative paths using forward slashes.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fg from "fast-glob";

import { git } from "../../git/git.js";
import { resolveOwnershipForPath } from "../extract/ownership.js";
import type { ControlPlaneModel } from "../model/schema.js";
import type { TaskManifest } from "../../core/task-manifest.js";

export type DerivedScopeConfidence = "high" | "medium" | "low";

export type DerivedScopeReport = {
  task_id: string;
  task_name: string;
  derived_write_resources: string[];
  derived_write_paths?: string[];
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
}): Promise<DerivedScopeReport> {
  const derived = await deriveTaskWriteScope({
    manifest: input.manifest,
    model: input.model,
    snapshotPath: input.snapshotPath,
    componentResourcePrefix: input.componentResourcePrefix,
    fallbackResource: input.fallbackResource,
  });

  return {
    task_id: input.manifest.id,
    task_name: input.manifest.name,
    derived_write_resources: derived.derivedWriteResources,
    derived_write_paths: derived.derivedWritePaths,
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
  confidence: DerivedScopeConfidence;
  notes: string[];
};

async function deriveTaskWriteScope(input: {
  manifest: TaskManifest;
  model: ControlPlaneModel;
  snapshotPath: string;
  componentResourcePrefix: string;
  fallbackResource: string;
}): Promise<DerivedWriteScope> {
  const fallbackResource = normalizeFallbackResource(input.fallbackResource);
  const notes: string[] = [];

  const componentLocks = findComponentLocks(
    input.manifest.locks?.writes ?? [],
    input.componentResourcePrefix,
  );

  if (componentLocks.length > 0) {
    const derivedWriteResources = dedupeAndSort(componentLocks);
    const derivedWritePaths = buildDerivedWritePaths({
      resources: derivedWriteResources,
      model: input.model,
      componentResourcePrefix: input.componentResourcePrefix,
      notes,
    });

    return {
      derivedWriteResources,
      derivedWritePaths,
      confidence: "high",
      notes,
    };
  }

  const writeGlobs = normalizeStringList(input.manifest.files?.writes ?? []);
  const expandedFiles = await expandWriteGlobs(writeGlobs, input.snapshotPath);

  if (expandedFiles.length === 0) {
    notes.push(
      writeGlobs.length === 0
        ? `No manifest write globs provided; widened to ${fallbackResource}.`
        : `No files matched manifest write globs; widened to ${fallbackResource}.`,
    );

    return {
      derivedWriteResources: fallbackResource ? [fallbackResource] : [],
      confidence: "low",
      notes,
    };
  }

  const { resources, missingOwners } = resolveComponentResourcesForFiles({
    files: expandedFiles,
    model: input.model,
    componentResourcePrefix: input.componentResourcePrefix,
  });

  const derivedWriteResources = dedupeAndSort(
    missingOwners.length > 0 && fallbackResource
      ? [...resources, fallbackResource]
      : resources,
  );

  const derivedWritePaths = buildDerivedWritePaths({
    resources: derivedWriteResources,
    model: input.model,
    componentResourcePrefix: input.componentResourcePrefix,
    notes,
  });

  if (missingOwners.length > 0 && fallbackResource) {
    notes.push(buildMissingOwnerNote(missingOwners, fallbackResource));
  }

  if (resources.length === 0 && fallbackResource && missingOwners.length === 0) {
    notes.push(`No component owners resolved; widened to ${fallbackResource}.`);
  }

  return {
    derivedWriteResources,
    derivedWritePaths,
    confidence: missingOwners.length > 0 || resources.length === 0 ? "low" : "medium",
    notes,
  };
}

function findComponentLocks(locks: string[], prefix: string): string[] {
  return locks.filter((lock) => lock.startsWith(prefix));
}

async function expandWriteGlobs(globs: string[], snapshotPath: string): Promise<string[]> {
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

function resolveComponentResourcesForFiles(input: {
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

function buildDerivedWritePaths(input: {
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
      `Component resources missing from control plane model: ${missingComponents.join(", ")}`,
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

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}

function normalizeFallbackResource(resource: string): string {
  const trimmed = resource.trim();
  return trimmed.length > 0 ? trimmed : "repo-root";
}

function normalizeStringList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function dedupeAndSort(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function buildMissingOwnerNote(files: string[], fallbackResource: string): string {
  const maxSamples = 3;
  const samples = files.slice(0, maxSamples);
  const suffix = files.length > maxSamples ? ` (+${files.length - maxSamples} more)` : "";
  return `Missing ownership for ${files.length} file(s); widened to ${fallbackResource}. ${samples.join(
    ", ",
  )}${suffix}`;
}
