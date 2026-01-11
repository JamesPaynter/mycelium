import {
  locksConflict,
  normalizeLocks,
  type NormalizedLocks,
  type TaskSpec,
} from "./task-manifest.js";

export type Batch = TaskSpec[];

export function buildGreedyBatch(
  available: TaskSpec[],
  maxParallel: number,
): { batch: TaskSpec[]; remaining: TaskSpec[] } {
  assertMaxParallel(maxParallel);

  const sorted = sortByTaskId(available);
  return buildBatchFromSorted(sorted, maxParallel);
}

export function buildBatches(available: TaskSpec[], maxParallel: number): Batch[] {
  assertMaxParallel(maxParallel);

  const batches: Batch[] = [];
  let remaining = sortByTaskId(available);

  while (remaining.length > 0) {
    const { batch, remaining: nextRemaining } = buildBatchFromSorted(remaining, maxParallel);
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
): { batch: TaskSpec[]; remaining: TaskSpec[] } {
  const remaining = [...available];
  const batchLocks = createBatchLocks();
  const batch: TaskSpec[] = [];

  for (const task of [...remaining]) {
    if (batch.length >= maxParallel) break;

    const locks = normalizeLocks(task.manifest.locks);
    if (canRunInSameBatch(locks, batchLocks)) {
      batch.push(task);
      addToBatch(locks, batchLocks);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }

  if (batch.length === 0 && available.length > 0) {
    throw new Error("Scheduler could not place any tasks into a batch; check lock definitions.");
  }

  return { batch, remaining };
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

function sortByTaskId(tasks: TaskSpec[]): TaskSpec[] {
  return [...tasks].sort(compareTaskById);
}

function compareTaskById(a: TaskSpec, b: TaskSpec): number {
  const ai = Number(a.manifest.id);
  const bi = Number(b.manifest.id);

  if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
  return a.manifest.id.localeCompare(b.manifest.id);
}

function assertMaxParallel(maxParallel: number): void {
  if (maxParallel < 1) {
    throw new Error(`maxParallel must be at least 1 (received ${maxParallel})`);
  }
}
