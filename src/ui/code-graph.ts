// UI code graph snapshot helpers.
// Purpose: load control-plane model artifacts and compute component growth stats for the UI map.
// Assumes control-plane models live under <repo>/.mycelium/control-plane/models/<base_sha>.

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isGitRepo, pathExists, readJsonFile } from "../core/utils.js";
import type { RunState } from "../core/state.js";
import type { ControlPlaneModel, ControlPlaneComponent } from "../control-plane/model/schema.js";
import type { ControlPlaneModelMetadata } from "../control-plane/metadata.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// TYPES
// =============================================================================

export type CodeGraphComponent = {
  id: string;
  roots: string[];
  kind: string;
};

export type CodeGraphDependency = {
  from: string;
  to: string;
};

export type ComponentStats = {
  code_loc: number;
  code_files: number;
  unit_test_files: number;
  integration_test_files: number;
  e2e_test_files: number;
};

export type CodeGraphSnapshot = {
  base_sha: string;
  model: {
    schema_version: number | null;
    built_at: string | null;
  };
  components: CodeGraphComponent[];
  deps: CodeGraphDependency[];
  stats: Record<string, ComponentStats>;
  run_quality: {
    integration_doctor_passed: boolean | null;
  };
};

export type CodeGraphErrorCode =
  | "MODEL_NOT_FOUND"
  | "INVALID_BASE_SHA"
  | "REPO_NOT_FOUND"
  | "BASE_SHA_RESOLUTION_FAILED";

export type CodeGraphError = {
  code: CodeGraphErrorCode;
  message: string;
  hint?: string;
};

export type CodeGraphSnapshotResult =
  | { ok: true; result: CodeGraphSnapshot }
  | { ok: false; error: CodeGraphError };

type ModelReadResult =
  | {
      ok: true;
      model: ControlPlaneModel;
      metadata: ControlPlaneModelMetadata | null;
      modelMtimeMs: number;
    }
  | { ok: false; reason: "not_found" | "invalid_path" };

// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadCodeGraphSnapshot(params: {
  state: RunState;
  baseShaOverride?: string | null;
}): Promise<CodeGraphSnapshotResult> {
  const repoPath = path.resolve(params.state.repo_path);
  const repoExists = await ensureRepoPath(repoPath);
  if (!repoExists) {
    return {
      ok: false,
      error: {
        code: "REPO_NOT_FOUND",
        message: `Repo path not found: ${repoPath}.`,
      },
    };
  }

  const baseSha = await resolveBaseSha({
    repoPath,
    baseShaOverride: params.baseShaOverride ?? null,
    stateBaseSha: params.state.control_plane?.base_sha ?? null,
    mainBranch: params.state.main_branch,
  });

  if (!baseSha) {
    return {
      ok: false,
      error: {
        code: "BASE_SHA_RESOLUTION_FAILED",
        message: "Unable to resolve base SHA for the run.",
        hint: "Provide ?baseSha=<sha> or ensure the repo has git history.",
      },
    };
  }

  const normalizedSha = normalizeSha(baseSha);
  if (!isValidSha(normalizedSha)) {
    return {
      ok: false,
      error: {
        code: "INVALID_BASE_SHA",
        message: `Invalid base SHA: ${baseSha}.`,
      },
    };
  }

  const modelResult = await readControlPlaneModel(repoPath, normalizedSha);
  if (!modelResult.ok) {
    if (modelResult.reason === "not_found") {
      return {
        ok: false,
        error: {
          code: "MODEL_NOT_FOUND",
          message: `No control-plane model found for base_sha ${normalizedSha}.`,
          hint: `Run: mycelium cp build --base-sha ${normalizedSha}`,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "INVALID_BASE_SHA",
        message: `Invalid base SHA: ${normalizedSha}.`,
      },
    };
  }

  const components = normalizeComponents(modelResult.model.components);
  const deps = normalizeDeps(modelResult.model);
  const stats = await getComponentStats({
    repoPath,
    baseSha: normalizedSha,
    modelMtimeMs: modelResult.modelMtimeMs,
    components,
  });

  return {
    ok: true,
    result: {
      base_sha: normalizedSha,
      model: {
        schema_version: modelResult.metadata?.schema_version ?? null,
        built_at: modelResult.metadata?.built_at ?? null,
      },
      components,
      deps,
      stats,
      run_quality: computeRunQuality(params.state),
    },
  };
}

// =============================================================================
// BASE SHA RESOLUTION
// =============================================================================

async function resolveBaseSha(params: {
  repoPath: string;
  baseShaOverride: string | null;
  stateBaseSha: string | null;
  mainBranch: string;
}): Promise<string | null> {
  if (params.baseShaOverride && params.baseShaOverride.trim()) {
    return params.baseShaOverride.trim();
  }

  if (params.stateBaseSha && params.stateBaseSha.trim()) {
    return params.stateBaseSha.trim();
  }

  const fromBranch = await resolveGitSha(params.repoPath, params.mainBranch);
  if (fromBranch) {
    return fromBranch;
  }

  return resolveGitSha(params.repoPath, "HEAD");
}

async function resolveGitSha(repoPath: string, ref: string): Promise<string | null> {
  if (!isGitRepo(repoPath)) {
    return null;
  }

  try {
    const result = await execFileAsync("git", ["rev-parse", ref], { cwd: repoPath });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

// =============================================================================
// MODEL LOADING
// =============================================================================

async function readControlPlaneModel(repoPath: string, baseSha: string): Promise<ModelReadResult> {
  const modelsRoot = path.join(repoPath, ".mycelium", "control-plane", "models");
  const modelDir = path.resolve(modelsRoot, baseSha);
  const relative = path.relative(modelsRoot, modelDir);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "invalid_path" };
  }

  const modelPath = path.join(modelDir, "model.json");
  const metadataPath = path.join(modelDir, "metadata.json");

  const stat = await fs.stat(modelPath).catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!stat || !stat.isFile()) {
    return { ok: false, reason: "not_found" };
  }

  const model = await readJsonFile<ControlPlaneModel>(modelPath);
  const metadata = await readJsonFile<ControlPlaneModelMetadata>(metadataPath).catch(() => null);

  return {
    ok: true,
    model,
    metadata,
    modelMtimeMs: stat.mtimeMs,
  };
}

// =============================================================================
// COMPONENT STATS
// =============================================================================

const componentStatsCache = new Map<string, Record<string, ComponentStats>>();

async function getComponentStats(params: {
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

function computeRunQuality(state: RunState): { integration_doctor_passed: boolean | null } {
  const passed = state.batches.some((batch) => batch.integration_doctor_passed === true);
  if (passed) {
    return { integration_doctor_passed: true };
  }

  if (state.status === "complete") {
    return { integration_doctor_passed: false };
  }

  return { integration_doctor_passed: null };
}

// =============================================================================
// UTILITIES
// =============================================================================

function normalizeComponents(components: ControlPlaneComponent[]): CodeGraphComponent[] {
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

function normalizeDeps(model: ControlPlaneModel): CodeGraphDependency[] {
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

function normalizeSha(baseSha: string): string {
  return baseSha.trim().toLowerCase();
}

function isValidSha(baseSha: string): boolean {
  return SHA_REGEX.test(baseSha);
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldSkipDir(dirName: string): boolean {
  return SKIPPED_DIRS.has(dirName);
}

async function ensureRepoPath(repoPath: string): Promise<boolean> {
  if (!(await pathExists(repoPath))) {
    return false;
  }

  const stat = await fs.stat(repoPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

function toRepoRelativePath(repoPath: string, absolutePath: string): string {
  const relativePath = path.relative(repoPath, absolutePath);
  return normalizeRepoPath(relativePath);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  return withoutDot.replace(/\/+$/, "");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SHA_REGEX = /^[a-f0-9]{7,40}$/i;
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
