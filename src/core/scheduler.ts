import type { TaskManifest, TaskSpec } from "./manifest.js";

export type Batch = TaskSpec[];

export type BatchFiles = {
  reads: Set<string>;
  writes: Set<string>;
};

export function canRunInSameBatch(task: TaskManifest, batch: BatchFiles): boolean {
  for (const r of task.locks.writes ?? []) {
    if (batch.reads.has(r) || batch.writes.has(r)) return false;
  }
  for (const r of task.locks.reads ?? []) {
    if (batch.writes.has(r)) return false;
  }
  return true;
}

export function addToBatch(task: TaskManifest, batch: BatchFiles): void {
  for (const r of task.locks.reads ?? []) batch.reads.add(r);
  for (const r of task.locks.writes ?? []) batch.writes.add(r);
}

export function buildGreedyBatch(available: TaskSpec[], maxParallel: number): { batch: TaskSpec[]; remaining: TaskSpec[] } {
  const remaining = [...available];
  const batch: TaskSpec[] = [];
  const batchLocks: BatchFiles = { reads: new Set(), writes: new Set() };

  for (const task of [...remaining]) {
    if (batch.length >= maxParallel) break;
    if (canRunInSameBatch(task.manifest, batchLocks)) {
      batch.push(task);
      addToBatch(task.manifest, batchLocks);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }

  return { batch, remaining };
}

export function topologicalReady(tasks: TaskSpec[], completed: Set<string>): TaskSpec[] {
  return tasks.filter((t) => {
    const deps = t.manifest.dependencies ?? [];
    return deps.every((d) => completed.has(d));
  });
}
