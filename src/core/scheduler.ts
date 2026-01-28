import { UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import {
  locksConflict,
  normalizeLocks,
  type NormalizedLocks,
  type TaskSpec,
} from "./task-manifest.js";

export type BatchPlan = {
  tasks: TaskSpec[];
  locks: NormalizedLocks;
};

export type LockResolver = (task: TaskSpec) => NormalizedLocks;

const SCHEDULER_PLACEMENT_TITLE = "Scheduler placement failed.";
const SCHEDULER_PLACEMENT_MESSAGE = "No tasks could be placed into a runnable batch.";
const SCHEDULER_PLACEMENT_HINT =
  "Review task locks and configured resources, then rerun with --debug for details.";

type PlacementDetail = {
  task: TaskSpec;
  locks: NormalizedLocks;
};

function resolveTaskLocks(task: TaskSpec): NormalizedLocks {
  return normalizeLocks(task.manifest.locks);
}

export function buildGreedyBatch(
  available: TaskSpec[],
  maxParallel: number,
  resolveLocks: LockResolver = resolveTaskLocks,
): { batch: BatchPlan; remaining: TaskSpec[] } {
  assertMaxParallel(maxParallel);

  const sorted = sortByTaskId(available);
  return buildBatchFromSorted(sorted, maxParallel, resolveLocks);
}

export function buildBatches(
  available: TaskSpec[],
  maxParallel: number,
  resolveLocks: LockResolver = resolveTaskLocks,
): BatchPlan[] {
  assertMaxParallel(maxParallel);

  const batches: BatchPlan[] = [];
  let remaining = sortByTaskId(available);

  while (remaining.length > 0) {
    const { batch, remaining: nextRemaining } = buildBatchFromSorted(
      remaining,
      maxParallel,
      resolveLocks,
    );
    batches.push(batch);
    remaining = nextRemaining;
  }

  return batches;
}

export function topologicalReady(tasks: TaskSpec[], completed: Set<string>): TaskSpec[] {
  return sortByTaskId(tasks).filter((task) => {
    const deps = task.manifest.dependencies ?? [];
    return deps.every((dep) => completed.has(dep));
  });
}

type BatchLocks = {
  reads: Set<string>;
  writes: Set<string>;
};

function buildBatchFromSorted(
  available: TaskSpec[],
  maxParallel: number,
  resolveLocks: LockResolver,
): { batch: BatchPlan; remaining: TaskSpec[] } {
  const remaining = [...available];
  const batchLocks = createBatchLocks();
  const batch: TaskSpec[] = [];
  const placementDetails: PlacementDetail[] = [];

  for (const task of [...remaining]) {
    if (batch.length >= maxParallel) break;

    const locks = resolveLocks(task);
    placementDetails.push({ task, locks });
    if (canRunInSameBatch(locks, batchLocks)) {
      batch.push(task);
      addToBatch(locks, batchLocks);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }

  if (batch.length === 0 && available.length > 0) {
    throw createSchedulerPlacementError(placementDetails);
  }

  return {
    batch: { tasks: batch, locks: toNormalizedLocks(batchLocks) },
    remaining,
  };
}

function canRunInSameBatch(locks: NormalizedLocks, batchLocks: BatchLocks): boolean {
  const batchAsLocks: NormalizedLocks = {
    reads: [...batchLocks.reads],
    writes: [...batchLocks.writes],
  };

  return !locksConflict(locks, batchAsLocks);
}

function addToBatch(locks: NormalizedLocks, batchLocks: BatchLocks): void {
  for (const r of locks.reads) batchLocks.reads.add(r);
  for (const r of locks.writes) batchLocks.writes.add(r);
}

function createBatchLocks(): BatchLocks {
  return { reads: new Set(), writes: new Set() };
}

function toNormalizedLocks(batchLocks: BatchLocks): NormalizedLocks {
  return {
    reads: [...batchLocks.reads].sort(),
    writes: [...batchLocks.writes].sort(),
  };
}

function sortByTaskId(tasks: TaskSpec[]): TaskSpec[] {
  return [...tasks].sort(compareTaskById);
}

function compareTaskById(a: TaskSpec, b: TaskSpec): number {
  const ai = Number(a.manifest.id);
  const bi = Number(b.manifest.id);

  if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
  return a.manifest.id.localeCompare(b.manifest.id);
}

function createSchedulerPlacementError(details: PlacementDetail[]): UserFacingError {
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: SCHEDULER_PLACEMENT_TITLE,
    message: SCHEDULER_PLACEMENT_MESSAGE,
    hint: SCHEDULER_PLACEMENT_HINT,
    cause: new Error(formatSchedulerPlacementCause(details)),
  });
}

function formatSchedulerPlacementCause(details: PlacementDetail[]): string {
  const baseMessage = "Scheduler could not place any tasks into a batch; check lock definitions.";

  if (details.length === 0) {
    return baseMessage;
  }

  const lines = details.map(formatSchedulerPlacementDetail).join("\n");
  return `${baseMessage}\n${lines}`;
}

function formatSchedulerPlacementDetail(detail: PlacementDetail): string {
  const reads = formatLockList(detail.locks.reads);
  const writes = formatLockList(detail.locks.writes);

  return `${detail.task.manifest.id} ${detail.task.manifest.name}: reads=[${reads}] writes=[${writes}]`;
}

function formatLockList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function assertMaxParallel(maxParallel: number): void {
  if (maxParallel < 1) {
    throw new Error(`maxParallel must be at least 1 (received ${maxParallel})`);
  }
}
