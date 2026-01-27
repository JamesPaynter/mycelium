import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

import type { RunState } from "../core/state.js";

import type {
  CodeGraphComponent,
  ComponentStats,
} from "./code-graph-types.js";
import { isWithinRoot, toRepoRelativePath } from "./code-graph-utils.js";

// =============================================================================
// COMPONENT STATS
// =============================================================================

const componentStatsCache = new Map<string, Record<string, ComponentStats>>();

export async function getComponentStats(params: {
  repoPath: string;
  baseSha: string;
  modelMtimeMs: number;
  components: CodeGraphComponent[];
}): Promise<Record<string, ComponentStats>> {
  const cacheKey = `${params.repoPath}::${params.baseSha}::${Math.floor(params.modelMtimeMs)}`;
  const cached = componentStatsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const stats: Record<string, ComponentStats> = {};

  for (const component of params.components) {
    stats[component.id] = await computeStatsForComponent(params.repoPath, component);
  }

  componentStatsCache.set(cacheKey, stats);
  return stats;
}

async function computeStatsForComponent(
  repoPath: string,
  component: CodeGraphComponent,
): Promise<ComponentStats> {
  const resolvedRoots = resolveComponentRoots(repoPath, component.roots);
  if (resolvedRoots.length === 0) {
    return emptyComponentStats();
  }

  const seenFiles = new Set<string>();
  const stats = emptyComponentStats();

  for (const root of resolvedRoots) {
    await walkComponentRoot(repoPath, root, seenFiles, stats);
  }

  return stats;
}

async function walkComponentRoot(
  repoPath: string,
  root: string,
  seenFiles: Set<string>,
  stats: ComponentStats,
): Promise<void> {
  const entries = await safeReadDir(root);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        continue;
      }

      await walkComponentRoot(repoPath, fullPath, seenFiles, stats);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const resolved = path.resolve(fullPath);
    if (seenFiles.has(resolved)) {
      continue;
    }
    seenFiles.add(resolved);

    const normalizedPath = toRepoRelativePath(repoPath, resolved);
    const testKind = classifyTestFile(normalizedPath);
    if (testKind) {
      incrementTestCount(stats, testKind);
      continue;
    }

    if (!isCodeFile(resolved)) {
      continue;
    }

    stats.code_files += 1;
    stats.code_loc += await countFileNewlines(resolved, MAX_CODE_FILE_BYTES);
  }
}

// =============================================================================
// FILE SCANNING
// =============================================================================

async function countFileNewlines(filePath: string, maxBytes: number): Promise<number> {
  let handle: FileHandle | null = null;

  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (stat.size === 0) return 0;

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return countNewlines(buffer.subarray(0, bytesRead));
  } catch {
    return 0;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const value of buffer.values()) {
    if (value === NEWLINE_BYTE) {
      count += 1;
    }
  }
  return count;
}

async function safeReadDir(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissingFile(err)) return null;
    return null;
  }
}

// =============================================================================
// RUN QUALITY
// =============================================================================

export function computeRunQuality(state: RunState): { integration_doctor_passed: boolean | null } {
  const passed = state.batches.some((batch) => batch.integration_doctor_passed === true);
  if (passed) {
    return { integration_doctor_passed: true };
  }

  if (state.status === "complete") {
    return { integration_doctor_passed: false };
  }

  return { integration_doctor_passed: null };
}

function resolveComponentRoots(repoPath: string, roots: string[]): string[] {
  const resolved = new Set<string>();

  for (const root of roots) {
    if (!root || path.isAbsolute(root)) {
      continue;
    }

    const absolute = path.resolve(repoPath, root);
    if (!isWithinRoot(repoPath, absolute)) {
      continue;
    }

    resolved.add(absolute);
  }

  return Array.from(resolved);
}

function classifyTestFile(normalizedPath: string): "unit" | "integration" | "e2e" | null {
  if (E2E_TEST_REGEX.test(normalizedPath)) {
    return "e2e";
  }

  if (INTEGRATION_TEST_REGEX.test(normalizedPath)) {
    return "integration";
  }

  if (UNIT_TEST_REGEX.test(normalizedPath)) {
    return "unit";
  }

  return null;
}

function incrementTestCount(stats: ComponentStats, kind: "unit" | "integration" | "e2e"): void {
  if (kind === "unit") {
    stats.unit_test_files += 1;
    return;
  }

  if (kind === "integration") {
    stats.integration_test_files += 1;
    return;
  }

  stats.e2e_test_files += 1;
}

function emptyComponentStats(): ComponentStats {
  return {
    code_loc: 0,
    code_files: 0,
    unit_test_files: 0,
    integration_test_files: 0,
    e2e_test_files: 0,
  };
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldSkipDir(dirName: string): boolean {
  return SKIPPED_DIRS.has(dirName);
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}

// =============================================================================
// CONSTANTS
// =============================================================================

const NEWLINE_BYTE = 10;
const MAX_CODE_FILE_BYTES = 1024 * 1024;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".mycelium",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "vendor",
]);

const UNIT_TEST_REGEX = /(^|\/)__tests__(\/|$)|\.(test|spec)\.[^/]+$/i;
const INTEGRATION_TEST_REGEX = /(^|\/)integration(\/|$)|\.integration\.[^/]+$/i;
const E2E_TEST_REGEX = /(^|\/)e2e(\/|$)|\.e2e\.[^/]+$/i;
