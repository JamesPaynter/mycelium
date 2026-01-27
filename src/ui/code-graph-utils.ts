import fs from "node:fs/promises";
import path from "node:path";

import type { ControlPlaneComponent, ControlPlaneModel } from "../control-plane/model/schema.js";
import { pathExists } from "../core/utils.js";

import type { CodeGraphComponent, CodeGraphDependency } from "./code-graph-types.js";

// =============================================================================
// NORMALIZATION
// =============================================================================

export function normalizeComponents(components: ControlPlaneComponent[]): CodeGraphComponent[] {
  if (!Array.isArray(components)) {
    return [];
  }

  return components
    .map((component) => ({
      id: component.id,
      roots: normalizeRoots(component.roots),
      kind: component.kind ?? "unknown",
    }))
    .filter((component) => component.id);
}

export function normalizeDeps(model: ControlPlaneModel): CodeGraphDependency[] {
  const edges = model.deps?.edges;
  if (!Array.isArray(edges)) {
    return [];
  }

  return edges
    .map((edge) => ({
      from: edge.from_component,
      to: edge.to_component,
    }))
    .filter((edge) => edge.from && edge.to);
}

export function normalizeSha(baseSha: string): string {
  return baseSha.trim().toLowerCase();
}

export function isValidSha(baseSha: string): boolean {
  return SHA_REGEX.test(baseSha);
}

export async function ensureRepoPath(repoPath: string): Promise<boolean> {
  if (!(await pathExists(repoPath))) {
    return false;
  }

  const stat = await fs.stat(repoPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

export function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  return withoutDot.replace(/\/+$/, "");
}

export function toRepoRelativePath(repoPath: string, absolutePath: string): string {
  const relativePath = path.relative(repoPath, absolutePath);
  return normalizeRepoPath(relativePath);
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeRoots(roots: string[] | undefined): string[] {
  if (!Array.isArray(roots)) {
    return [];
  }

  return Array.from(
    new Set(
      roots
        .filter((root) => typeof root === "string")
        .map((root) => normalizeRepoPath(root))
        .filter((root) => root.length > 0),
    ),
  );
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SHA_REGEX = /^[a-f0-9]{7,40}$/i;
