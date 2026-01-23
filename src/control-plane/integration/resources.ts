// Control plane resource integration.
// Purpose: derive lockable resources and ownership resolvers from the component graph.
// Assumes component roots are repo-relative paths using forward slashes.

import path from "node:path";

import { resolveOwnershipForPath } from "../extract/ownership.js";
import type { ControlPlaneModel } from "../model/schema.js";
import type { ResourceConfig } from "../../core/config.js";

export type ComponentOwnerResolver = (filePath: string) => string | null;

export type ComponentOwnershipDetail = {
  component_id: string;
  component_name: string;
  resource: string;
  root: string;
};

export type ComponentOwnershipResolver = (filePath: string) => ComponentOwnershipDetail[] | null;

export type DeriveComponentResourcesInput = {
  repoPath: string;
  baseSha: string;
  model: ControlPlaneModel;
  componentResourcePrefix: string;
};



// =============================================================================
// PUBLIC API
// =============================================================================

export function deriveComponentResources(input: DeriveComponentResourcesInput): ResourceConfig[] {
  const prefix = input.componentResourcePrefix;
  const resources = input.model.components.map((component) => ({
    name: `${prefix}${component.id}`,
    description: `Control plane component: ${component.name}`,
    paths: buildComponentPathPatterns(component.roots),
  }));

  return dedupeResources(resources).sort(compareResourceByName);
}

export function createComponentOwnerResolver(options: {
  model: ControlPlaneModel;
  componentResourcePrefix: string;
}): ComponentOwnerResolver {
  const prefix = options.componentResourcePrefix;

  return (filePath: string) => {
    const match = resolveOwnershipForPath(
      options.model.ownership,
      options.model.components,
      filePath,
    );
    if (!match.owner) {
      return null;
    }
    return `${prefix}${match.owner.component.id}`;
  };
}

export function createComponentOwnershipResolver(options: {
  model: ControlPlaneModel;
  componentResourcePrefix: string;
}): ComponentOwnershipResolver {
  const prefix = options.componentResourcePrefix;

  return (filePath: string) => {
    const match = resolveOwnershipForPath(
      options.model.ownership,
      options.model.components,
      filePath,
    );
    if (!match.owner) {
      return null;
    }

    const candidates = match.candidates.length > 0 ? match.candidates : [match.owner];
    return candidates.map((candidate) => ({
      component_id: candidate.component.id,
      component_name: candidate.component.name,
      resource: `${prefix}${candidate.component.id}`,
      root: candidate.root,
    }));
  };
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

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

function dedupeResources(resources: ResourceConfig[]): ResourceConfig[] {
  const seen = new Set<string>();
  const unique: ResourceConfig[] = [];

  for (const resource of resources) {
    if (seen.has(resource.name)) {
      continue;
    }
    seen.add(resource.name);
    unique.push(resource);
  }

  return unique;
}

function compareResourceByName(a: ResourceConfig, b: ResourceConfig): number {
  return a.name.localeCompare(b.name);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}
