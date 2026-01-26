// Control plane ownership extraction.
// Purpose: map component roots to owning components and resolve path ownership.
// Assumes component roots are repo-relative paths using forward slashes.

import path from "node:path";

import type {
  ControlPlaneComponent,
  ControlPlaneOwnership,
  ControlPlaneOwnershipRoot,
} from "../model/schema.js";

export type ControlPlaneOwnershipCandidate = {
  component: ControlPlaneComponent;
  root: string;
};

export type ControlPlaneOwnershipMatch = {
  path: string;
  owner: ControlPlaneOwnershipCandidate | null;
  candidates: ControlPlaneOwnershipCandidate[];
};

type OwnershipMatchCandidate = {
  component: ControlPlaneComponent;
  root: string;
  depth: number;
};

// =============================================================================
// INDEX BUILD
// =============================================================================

export function buildOwnershipIndex(components: ControlPlaneComponent[]): ControlPlaneOwnership {
  const roots: ControlPlaneOwnershipRoot[] = [];
  const seen = new Set<string>();

  for (const component of components) {
    for (const rawRoot of component.roots) {
      const root = normalizeRepoPath(rawRoot);
      const key = `${component.id}::${root}`;
      if (seen.has(key)) {
        continue;
      }

      roots.push({ component_id: component.id, root });
      seen.add(key);
    }
  }

  roots.sort(compareOwnershipRoots);
  return { roots };
}

// =============================================================================
// OWNER RESOLUTION
// =============================================================================

export function resolveOwnershipForPath(
  ownership: ControlPlaneOwnership,
  components: ControlPlaneComponent[],
  repoRelativePath: string,
): ControlPlaneOwnershipMatch {
  const normalizedPath = normalizeRepoPath(repoRelativePath);
  const componentById = new Map(components.map((component) => [component.id, component]));
  const matches: OwnershipMatchCandidate[] = [];

  for (const entry of ownership.roots) {
    if (!isPathWithinRoot(normalizedPath, entry.root)) {
      continue;
    }

    const component = componentById.get(entry.component_id);
    if (!component) {
      continue;
    }

    matches.push({ component, root: entry.root, depth: rootDepth(entry.root) });
  }

  const bestByComponent = new Map<string, OwnershipMatchCandidate>();
  for (const match of matches) {
    const existing = bestByComponent.get(match.component.id);
    if (!existing || match.depth > existing.depth) {
      bestByComponent.set(match.component.id, match);
      continue;
    }

    if (match.depth === existing.depth && match.root.localeCompare(existing.root) < 0) {
      bestByComponent.set(match.component.id, match);
    }
  }

  const bestMatches = Array.from(bestByComponent.values());
  if (bestMatches.length === 0) {
    return { path: normalizedPath, owner: null, candidates: [] };
  }

  const maxDepth = bestMatches.reduce((max, match) => Math.max(max, match.depth), 0);
  const tied = bestMatches
    .filter((match) => match.depth === maxDepth)
    .sort(compareOwnershipCandidates);

  const owner = tied[0] ? toOwnershipCandidate(tied[0]) : null;
  const candidates = tied.map(toOwnershipCandidate);

  return {
    path: normalizedPath,
    owner,
    candidates,
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function compareOwnershipRoots(a: ControlPlaneOwnershipRoot, b: ControlPlaneOwnershipRoot): number {
  if (a.root !== b.root) {
    return a.root.localeCompare(b.root);
  }
  return a.component_id.localeCompare(b.component_id);
}

function compareOwnershipCandidates(
  a: OwnershipMatchCandidate,
  b: OwnershipMatchCandidate,
): number {
  if (a.component.id !== b.component.id) {
    return a.component.id.localeCompare(b.component.id);
  }
  return a.root.localeCompare(b.root);
}

function toOwnershipCandidate(candidate: OwnershipMatchCandidate): ControlPlaneOwnershipCandidate {
  return { component: candidate.component, root: candidate.root };
}

function isPathWithinRoot(filePath: string, root: string): boolean {
  if (root.length === 0 || root === ".") {
    return true;
  }

  return filePath === root || filePath.startsWith(`${root}/`);
}

function rootDepth(root: string): number {
  if (root.length === 0 || root === ".") {
    return 0;
  }

  return root.split("/").length;
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}
