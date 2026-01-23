// Control plane git helpers.
// Purpose: resolve revisions and changed paths for control plane queries.
// Assumes the target repo is a valid git checkout.

import path from "node:path";

import { git } from "../git/git.js";



// =============================================================================
// REVISION RESOLUTION
// =============================================================================

export async function resolveBaseSha(input: {
  repoRoot: string;
  baseSha?: string | null;
  ref?: string | null;
}): Promise<string> {
  const baseSha = input.baseSha?.trim() ?? null;
  const ref = input.ref?.trim() ?? null;
  const target = baseSha || ref || "HEAD";

  const result = await git(input.repoRoot, ["rev-parse", target]);
  return result.stdout.trim();
}



// =============================================================================
// CHANGE QUERIES
// =============================================================================

export type ControlPlaneChangedPathInput = {
  repoRoot: string;
  changed?: string[] | null;
  diff?: string | null;
  against?: string | null;
};

export async function listChangedPaths(
  input: ControlPlaneChangedPathInput,
): Promise<string[]> {
  const repoRoot = path.resolve(input.repoRoot);
  const changed = normalizeChangedPaths(repoRoot, input.changed ?? null);
  const diff = normalizeOptionalString(input.diff);
  const against = normalizeOptionalString(input.against);

  const sources = [changed.length > 0, Boolean(diff), Boolean(against)];
  const activeSources = sources.filter(Boolean).length;
  if (activeSources > 1) {
    throw new Error("Provide only one of --changed, --diff, or --against.");
  }

  if (changed.length > 0) {
    return changed;
  }

  if (diff) {
    return listPathsFromDiff(repoRoot, diff);
  }

  if (against) {
    return listPathsFromDiff(repoRoot, `${against}...HEAD`);
  }

  return [];
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function listPathsFromDiff(repoRoot: string, diffRange: string): Promise<string[]> {
  const result = await git(repoRoot, ["diff", "--name-only", diffRange]);
  return normalizeGitOutput(result.stdout);
}

function normalizeGitOutput(stdout: string): string[] {
  const paths = new Set<string>();

  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const normalized = normalizeRepoPath(line);
      if (normalized.length > 0) {
        paths.add(normalized);
      }
    });

  return Array.from(paths).sort();
}

function normalizeChangedPaths(repoRoot: string, changed: string[] | null): string[] {
  if (!changed || changed.length === 0) {
    return [];
  }

  const paths = new Set<string>();

  for (const rawPath of changed) {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const resolvedPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(repoRoot, trimmed);
    const relative = path.relative(repoRoot, resolvedPath);
    const normalized = normalizeRepoPath(relative);
    if (normalized.length > 0) {
      paths.add(normalized);
    }
  }

  return Array.from(paths).sort();
}

function normalizeOptionalString(input?: string | null): string | null {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}
