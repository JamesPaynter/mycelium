import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import fse from "fs-extra";
import { z } from "zod";

import type { PathsContext } from "./paths.js";
import { runHistoryIndexPath, stateBaseDir } from "./paths.js";
import { loadRunState } from "./run-state-io.js";
import { RunStatusSchema, type RunState, type RunStatus } from "./state.js";
import { isoNow } from "./utils.js";

// =============================================================================
// TYPES
// =============================================================================

export type RunHistoryEntry = {
  runId: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  repoPath: string;
  taskCount: number;
};

export type RunHistoryIndex = {
  schemaVersion: number;
  updatedAt: string;
  runs: RunHistoryEntry[];
};

const RunHistoryEntrySchema = z
  .object({
    runId: z.string(),
    status: RunStatusSchema,
    startedAt: z.string(),
    updatedAt: z.string(),
    repoPath: z.string(),
    taskCount: z.number().int().nonnegative(),
  })
  .strict();

const RunHistoryIndexSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    updatedAt: z.string(),
    runs: z.array(RunHistoryEntrySchema),
  })
  .strict();

const RUN_HISTORY_SCHEMA_VERSION = 1;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function recordRunHistory(
  state: RunState,
  statePath: string,
  paths?: PathsContext,
): Promise<void> {
  if (!shouldRecordRunHistory(state.project, statePath, paths)) {
    return;
  }

  const entry = buildRunHistoryEntry(state);
  const index = await loadRunHistoryIndex(state.project, paths);
  const merged = mergeRunHistoryEntries(index?.runs ?? [], entry);
  const normalized: RunHistoryIndex = {
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    updatedAt: entry.updatedAt,
    runs: sortRunHistoryEntries(merged),
  };

  await writeRunHistoryIndex(state.project, normalized, paths);
}

export async function listRunHistoryEntries(
  projectName: string,
  opts: { limit?: number } = {},
  paths?: PathsContext,
): Promise<RunHistoryEntry[]> {
  const index = await loadRunHistoryIndex(projectName, paths);
  const stateEntries = await loadRunHistoryEntriesFromState(projectName, paths);

  const merged =
    stateEntries.length > 0
      ? sortRunHistoryEntries(stateEntries)
      : sortRunHistoryEntries(mergeRunHistoryLists(index?.runs ?? [], stateEntries));
  const limited = applyLimit(merged, opts.limit);

  if (shouldPersistIndex(index, merged)) {
    const updatedAt = merged[0]?.updatedAt ?? isoNow();
    await writeRunHistoryIndex(
      projectName,
      {
        schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
        updatedAt,
        runs: merged,
      },
      paths,
    );
  }

  return limited;
}

export function buildRunHistoryEntry(state: RunState): RunHistoryEntry {
  return {
    runId: state.run_id,
    status: state.status,
    startedAt: state.started_at,
    updatedAt: state.updated_at,
    repoPath: state.repo_path,
    taskCount: Object.keys(state.tasks ?? {}).length,
  };
}

// =============================================================================
// INDEX LOAD/SAVE
// =============================================================================

async function loadRunHistoryIndex(
  projectName: string,
  paths?: PathsContext,
): Promise<RunHistoryIndex | null> {
  const indexPath = runHistoryIndexPath(projectName, paths);
  const raw = await fs.readFile(indexPath, "utf8").catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!raw) {
    return null;
  }

  try {
    const parsed = RunHistoryIndexSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeRunHistoryIndex(
  projectName: string,
  index: RunHistoryIndex,
  paths?: PathsContext,
): Promise<void> {
  const indexPath = runHistoryIndexPath(projectName, paths);
  await writeJsonFileAtomic(indexPath, index);
}

// =============================================================================
// STATE BACKFILL
// =============================================================================

async function loadRunHistoryEntriesFromState(
  projectName: string,
  paths?: PathsContext,
): Promise<RunHistoryEntry[]> {
  const dir = stateBaseDir(projectName, paths);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!entries) {
    return [];
  }

  const runFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.startsWith("run-") && entry.name.endsWith(".json"),
  );

  const results: RunHistoryEntry[] = [];
  for (const file of runFiles) {
    const fullPath = path.join(dir, file.name);
    const state = await readRunStateFile(fullPath, paths);
    if (!state) continue;
    results.push(buildRunHistoryEntry(state));
  }

  return results;
}

async function readRunStateFile(filePath: string, paths?: PathsContext): Promise<RunState | null> {
  try {
    return await loadRunState(filePath, { paths });
  } catch (err) {
    if (isMissingFile(err)) return null;
    if (err instanceof Error && err.message.startsWith("Invalid run state")) {
      return null;
    }
    throw err;
  }
}

// =============================================================================
// MERGE + SORT
// =============================================================================

function mergeRunHistoryEntries(
  existing: RunHistoryEntry[],
  entry: RunHistoryEntry,
): RunHistoryEntry[] {
  const next = existing.filter((item) => item.runId !== entry.runId);
  next.push(entry);
  return next;
}

function mergeRunHistoryLists(
  existing: RunHistoryEntry[],
  incoming: RunHistoryEntry[],
): RunHistoryEntry[] {
  const byId = new Map<string, RunHistoryEntry>();

  for (const entry of existing) {
    byId.set(entry.runId, entry);
  }

  for (const entry of incoming) {
    byId.set(entry.runId, entry);
  }

  return Array.from(byId.values());
}

function sortRunHistoryEntries(entries: RunHistoryEntry[]): RunHistoryEntry[] {
  return [...entries].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt);
    const bTime = Date.parse(b.updatedAt);
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return a.runId.localeCompare(b.runId, undefined, { numeric: true, sensitivity: "base" });
  });
}

function shouldPersistIndex(
  existing: RunHistoryIndex | null,
  nextRuns: RunHistoryEntry[],
): boolean {
  if (!existing) return true;
  if (existing.schemaVersion !== RUN_HISTORY_SCHEMA_VERSION) return true;
  if (existing.runs.length !== nextRuns.length) return true;

  for (let i = 0; i < nextRuns.length; i += 1) {
    if (!isRunHistoryEntryEqual(existing.runs[i], nextRuns[i])) {
      return true;
    }
  }

  return false;
}

function applyLimit(entries: RunHistoryEntry[], limit?: number): RunHistoryEntry[] {
  if (!limit || !Number.isInteger(limit) || limit <= 0) {
    return entries;
  }

  return entries.slice(0, limit);
}

// =============================================================================
// UTILITIES
// =============================================================================

function shouldRecordRunHistory(
  projectName: string,
  statePath: string,
  paths?: PathsContext,
): boolean {
  const baseDir = path.resolve(stateBaseDir(projectName, paths));
  const resolved = path.resolve(statePath);
  const relative = path.relative(baseDir, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return true;
}

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fse.ensureDir(dir);

  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "w");

  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fse.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}

function isRunHistoryEntryEqual(a: RunHistoryEntry, b: RunHistoryEntry): boolean {
  return (
    a.runId === b.runId &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt &&
    a.repoPath === b.repoPath &&
    a.taskCount === b.taskCount
  );
}
