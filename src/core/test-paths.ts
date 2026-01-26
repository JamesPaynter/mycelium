import path from "node:path";

import { minimatch } from "minimatch";

export const DEFAULT_TEST_PATHS = [
  "**/__tests__/**",
  "**/tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*_spec.*",
];

export function normalizeTestPaths(paths?: string[]): string[] {
  return Array.from(
    new Set((paths ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)),
  ).sort();
}

export function resolveTestPaths(manifestPaths?: string[], fallbackPaths?: string[]): string[] {
  const normalizedManifest = normalizeTestPaths(manifestPaths);
  if (normalizedManifest.length > 0) {
    return normalizedManifest;
  }

  const normalizedFallback = normalizeTestPaths(fallbackPaths ?? DEFAULT_TEST_PATHS);
  return normalizedFallback.length > 0
    ? normalizedFallback
    : normalizeTestPaths(DEFAULT_TEST_PATHS);
}

export function isTestPath(file: string, patterns: string[]): boolean {
  const normalizedFile = toPosixPath(file);
  return patterns.some((pattern) =>
    minimatch(normalizedFile, toPosixPath(pattern), { dot: true, nocase: false }),
  );
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
