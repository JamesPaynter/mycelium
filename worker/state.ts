import path from "node:path";
import fs from "node:fs/promises";

import fse from "fs-extra";
import { z } from "zod";

import { isoNow } from "./logging.js";

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

const STATE_DIR = ".task-orchestrator";
const STATE_FILE = "worker-state.json";

const WorkerStateSchema = z.object({
  thread_id: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WorkerState = z.infer<typeof WorkerStateSchema>;

// =============================================================================
// PATH HELPERS
// =============================================================================

export function workerStatePath(workingDirectory: string): string {
  return path.join(workingDirectory, STATE_DIR, STATE_FILE);
}

// =============================================================================
// STATE STORE
// =============================================================================

export class WorkerStateStore {
  private state: WorkerState | null = null;

  constructor(private readonly workingDirectory: string) {}

  get path(): string {
    return workerStatePath(this.workingDirectory);
  }

  get current(): WorkerState | null {
    return this.state;
  }

  get threadId(): string | undefined {
    return this.state?.thread_id;
  }

  get nextAttempt(): number {
    return (this.state?.attempt ?? 0) + 1;
  }

  async load(): Promise<WorkerState | null> {
    this.state = await loadWorkerState(this.workingDirectory);
    return this.state;
  }

  async recordAttemptStart(attempt: number): Promise<WorkerState> {
    const now = isoNow();
    const createdAt = this.state?.created_at ?? now;
    const next: WorkerState = {
      thread_id: this.state?.thread_id,
      attempt,
      created_at: createdAt,
      updated_at: now,
    };

    await saveWorkerState(this.workingDirectory, next);
    this.state = next;
    return next;
  }

  async recordThreadId(threadId: string): Promise<WorkerState> {
    const now = isoNow();
    const base: WorkerState = this.state ?? {
      attempt: 0,
      created_at: now,
      updated_at: now,
    };

    if (base.thread_id === threadId) {
      return base;
    }

    const next: WorkerState = { ...base, thread_id: threadId, updated_at: now };
    await saveWorkerState(this.workingDirectory, next);
    this.state = next;
    return next;
  }
}

// =============================================================================
// FILE IO
// =============================================================================

export async function loadWorkerState(workingDirectory: string): Promise<WorkerState | null> {
  const filePath = workerStatePath(workingDirectory);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read worker state at ${filePath}: ${String(err)}`);
  }

  const parsed = WorkerStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid worker state at ${filePath}: ${parsed.error.toString()}`);
  }

  return parsed.data;
}

async function saveWorkerState(workingDirectory: string, state: WorkerState): Promise<void> {
  const filePath = workerStatePath(workingDirectory);
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}
