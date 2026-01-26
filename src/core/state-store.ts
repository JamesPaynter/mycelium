import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import fse from "fs-extra";

import type { PathsContext } from "./paths.js";
import { runStateDir, runStatePath, runStateTempPath } from "./paths.js";
import {
  RunStateSchema,
  resetRunningTasks,
  type BatchState,
  type RunState,
  type RunStatus,
  type TaskState,
  type TaskStatus,
} from "./state.js";
import { isoNow } from "./utils.js";
import { recordRunHistory } from "./run-history.js";

export type BatchStatusCounts = {
  total: number;
  pending: number;
  running: number;
  complete: number;
  failed: number;
};

export type TaskStatusCounts = {
  total: number;
  pending: number;
  running: number;
  validated: number;
  complete: number;
  failed: number;
  needs_human_review: number;
  needs_rescope: number;
  rescope_required: number;
  skipped: number;
};

export type TaskStatusRow = {
  id: string;
  status: TaskStatus;
  attempts: number;
  branch: string | null;
  threadId: string | null;
};

export type RunStatusSummary = {
  runId: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  tokensUsed: number;
  estimatedCost: number;
  batchCounts: BatchStatusCounts;
  taskCounts: TaskStatusCounts;
  tasks: TaskStatusRow[];
  humanReview: HumanReviewRow[];
  topSpenders: TaskSpendRow[];
};

export type HumanReviewRow = {
  id: string;
  validator: string;
  reason: string;
  summary: string | null;
  reportPath: string | null;
};

export type TaskSpendRow = {
  id: string;
  tokensUsed: number;
  estimatedCost: number;
};

export class StateStore {
  private readonly paths?: PathsContext;
  private readonly statePathValue: string;

  constructor(
    public readonly projectName: string,
    public readonly runId: string,
    pathsOrStatePath?: PathsContext | string,
    statePathOverride?: string,
  ) {
    const paths = typeof pathsOrStatePath === "string" ? undefined : pathsOrStatePath;
    const statePathValue =
      typeof pathsOrStatePath === "string"
        ? pathsOrStatePath
        : statePathOverride ?? runStatePath(projectName, runId, paths);

    this.paths = paths;
    this.statePathValue = statePathValue;
  }

  get statePath(): string {
    return this.statePathValue;
  }

  async exists(): Promise<boolean> {
    return fse.pathExists(this.statePathValue);
  }

  async load(): Promise<RunState> {
    return loadRunState(this.statePathValue);
  }

  async save(state: RunState): Promise<void> {
    await saveRunState(this.statePathValue, state, this.tempPath());
    await recordRunHistory(state, this.statePathValue, this.paths).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: failed to update run history for ${this.runId}. ${detail}`);
    });
  }

  async loadAndRecover(reason?: string): Promise<RunState> {
    const state = await this.load();
    resetRunningTasks(state, reason);
    await this.save(state);
    return state;
  }

  private tempPath(): string {
    const tempBase = runStateTempPath(this.projectName, this.runId, this.paths);
    const tempName = path.basename(tempBase);
    return path.join(path.dirname(this.statePathValue), `${tempName}.${randomUUID()}`);
  }
}

export async function findLatestRunId(
  projectName: string,
  paths?: PathsContext,
): Promise<string | null> {
  const dir = runStateDir(projectName, paths);
  if (!(await fse.pathExists(dir))) return null;

  const files = await fse.readdir(dir);
  const runFiles = files.filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (runFiles.length === 0) return null;

  const withMtime = await Promise.all(
    runFiles.map(async (file) => {
      const stat = await fse.stat(path.join(dir, file));
      return { file, mtime: stat.mtimeMs };
    }),
  );

  withMtime.sort((a, b) => b.mtime - a.mtime);
  return normalizeRunId(withMtime[0].file);
}

export async function loadRunStateForProject(
  projectName: string,
  runId?: string,
  paths?: PathsContext,
): Promise<{ runId: string; state: RunState } | null> {
  const resolvedRunId = runId ?? (await findLatestRunId(projectName, paths));
  if (!resolvedRunId) return null;

  const store = new StateStore(projectName, resolvedRunId, paths);
  if (!(await store.exists())) return null;

  const state = await store.load();
  return { runId: resolvedRunId, state };
}

export function summarizeRunState(state: RunState): RunStatusSummary {
  return {
    runId: state.run_id,
    status: state.status,
    startedAt: state.started_at,
    updatedAt: state.updated_at,
    tokensUsed: state.tokens_used ?? 0,
    estimatedCost: state.estimated_cost ?? 0,
    batchCounts: summarizeBatchStatuses(state.batches),
    taskCounts: summarizeTaskStatuses(state.tasks),
    tasks: buildTaskStatusRows(state.tasks),
    humanReview: buildHumanReviewRows(state.tasks),
    topSpenders: buildTopSpenders(state.tasks),
  };
}

export async function loadRunState(statePath: string): Promise<RunState> {
  const raw = await fse.readFile(statePath, "utf8");
  const parsed = RunStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid run state at ${statePath}: ${parsed.error.toString()}`);
  }

  return parsed.data;
}

export async function saveRunState(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const parsed = RunStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`Cannot save run state: ${parsed.error.toString()}`);
  }

  const normalized: RunState = { ...parsed.data, updated_at: isoNow() };
  Object.assign(state, normalized);

  await writeStateFile(statePath, normalized, tempPath);
}

export async function recoverRunState(
  statePath: string,
  reason?: string,
  tempPath?: string,
): Promise<RunState> {
  const state = await loadRunState(statePath);
  resetRunningTasks(state, reason);
  await saveRunState(statePath, state, tempPath);
  return state;
}

function summarizeBatchStatuses(batches: BatchState[]): BatchStatusCounts {
  const counts: BatchStatusCounts = {
    total: batches.length,
    pending: 0,
    running: 0,
    complete: 0,
    failed: 0,
  };

  for (const batch of batches) {
    counts[batch.status] += 1;
  }

  return counts;
}

function summarizeTaskStatuses(tasks: Record<string, TaskState>): TaskStatusCounts {
  const counts: TaskStatusCounts = {
    total: Object.keys(tasks).length,
    pending: 0,
    running: 0,
    validated: 0,
    complete: 0,
    failed: 0,
    needs_human_review: 0,
    needs_rescope: 0,
    rescope_required: 0,
    skipped: 0,
  };

  for (const task of Object.values(tasks)) {
    counts[task.status] += 1;
  }

  return counts;
}

function buildTaskStatusRows(tasks: Record<string, TaskState>): TaskStatusRow[] {
  return Object.entries(tasks)
    .map(([id, task]) => ({
      id,
      status: task.status,
      attempts: task.attempts ?? 0,
      branch: task.branch ?? null,
      threadId: task.thread_id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));
}

function buildHumanReviewRows(tasks: Record<string, TaskState>): HumanReviewRow[] {
  return Object.entries(tasks)
    .filter(([, task]) => task.status === "needs_human_review")
    .map(([id, task]) => {
      const review = task.human_review;
      return {
        id,
        validator: review?.validator ?? "unknown",
        reason: review?.reason ?? "Requires human review",
        summary: review?.summary ?? task.last_error ?? null,
        reportPath: review?.report_path ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));
}

function buildTopSpenders(tasks: Record<string, TaskState>, limit = 5): TaskSpendRow[] {
  return Object.entries(tasks)
    .map(([id, task]) => ({
      id,
      tokensUsed: task.tokens_used ?? 0,
      estimatedCost: task.estimated_cost ?? 0,
    }))
    .filter((row) => row.tokensUsed > 0 || row.estimatedCost > 0)
    .sort((a, b) => {
      if (b.estimatedCost !== a.estimatedCost) {
        return b.estimatedCost - a.estimatedCost;
      }
      if (b.tokensUsed !== a.tokensUsed) {
        return b.tokensUsed - a.tokensUsed;
      }
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
    })
    .slice(0, limit);
}

async function writeStateFile(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const dir = path.dirname(statePath);
  await fse.ensureDir(dir);

  const tmpPath = tempPath ?? `${statePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "w");

  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fse.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}

function normalizeRunId(fileName: string): string {
  return fileName.replace(/^run-/, "").replace(/\.json$/, "");
}
