/**
 * Orchestrator test fakes.
 * Purpose: provide deterministic adapters for run-engine unit tests.
 * Assumptions: fakes are in-memory and intentionally minimal.
 * Usage: import from run-engine.test.ts to build RunContext.
 */

import path from "node:path";

import { logOrchestratorEvent, type JsonObject, JsonlLogger } from "../../../core/logger.js";
import type { PathsContext } from "../../../core/paths.js";
import { StateStore } from "../../../core/state-store.js";
import type { MergeResult, TaskBranchToMerge } from "../../../git/merge.js";
import type { Clock, LogSink, StateRepository } from "../ports.js";
import type { Vcs } from "../vcs/vcs.js";
import type {
  WorkerCleanupInput,
  WorkerPrepareInput,
  WorkerResumeAttemptInput,
  WorkerRunAttemptInput,
  WorkerRunner,
  WorkerRunnerResult,
  WorkerStopInput,
  WorkerStopResult,
} from "../workers/worker-runner.js";

// =============================================================================
// WORKER RUNNER
// =============================================================================

type UsageEventPlan = {
  tokens: number;
  attempt?: number;
};

type QueuedWorkerResult = {
  result: WorkerRunnerResult;
  usage?: UsageEventPlan;
};

export class FakeWorkerRunner implements WorkerRunner {
  private readonly runQueue = new Map<string, QueuedWorkerResult[]>();
  private readonly resumeQueue = new Map<string, QueuedWorkerResult[]>();
  private stopResult: WorkerStopResult | null = null;

  readonly prepareCalls: WorkerPrepareInput[] = [];
  readonly runCalls: WorkerRunAttemptInput[] = [];
  readonly resumeCalls: WorkerResumeAttemptInput[] = [];
  readonly stopCalls: WorkerStopInput[] = [];
  readonly cleanupCalls: WorkerCleanupInput[] = [];

  queueRunAttempt(taskId: string, result: WorkerRunnerResult, usage?: UsageEventPlan): void {
    enqueueResult(this.runQueue, taskId, { result, usage });
  }

  queueResumeAttempt(taskId: string, result: WorkerRunnerResult, usage?: UsageEventPlan): void {
    enqueueResult(this.resumeQueue, taskId, { result, usage });
  }

  setStopResult(result: WorkerStopResult | null): void {
    this.stopResult = result;
  }

  async prepare(input: WorkerPrepareInput): Promise<void> {
    this.prepareCalls.push(input);
  }

  async runAttempt(input: WorkerRunAttemptInput): Promise<WorkerRunnerResult> {
    this.runCalls.push(input);
    const queued = dequeueResult(this.runQueue, input.taskId);
    if (queued?.usage) {
      logUsageEvent(input.taskEvents, queued.usage);
    }
    return queued?.result ?? { success: true };
  }

  async resumeAttempt(input: WorkerResumeAttemptInput): Promise<WorkerRunnerResult> {
    this.resumeCalls.push(input);
    const queued = dequeueResult(this.resumeQueue, input.taskId);
    if (queued?.usage) {
      logUsageEvent(input.taskEvents, queued.usage);
    }
    return queued?.result ?? { success: true };
  }

  async stop(input: WorkerStopInput): Promise<WorkerStopResult | null> {
    this.stopCalls.push(input);
    return this.stopResult;
  }

  async cleanupTask(input: WorkerCleanupInput): Promise<void> {
    this.cleanupCalls.push(input);
  }
}

function enqueueResult(
  queue: Map<string, QueuedWorkerResult[]>,
  taskId: string,
  result: QueuedWorkerResult,
): void {
  const existing = queue.get(taskId) ?? [];
  existing.push(result);
  queue.set(taskId, existing);
}

function dequeueResult(
  queue: Map<string, QueuedWorkerResult[]>,
  taskId: string,
): QueuedWorkerResult | undefined {
  const existing = queue.get(taskId);
  if (!existing || existing.length === 0) return undefined;
  return existing.shift();
}

function logUsageEvent(logger: JsonlLogger, usage: UsageEventPlan): void {
  logger.log({
    type: "codex.event",
    attempt: usage.attempt ?? 1,
    payload: {
      event: {
        type: "turn.completed",
        usage: {
          input_tokens: usage.tokens,
          cached_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  });
}

// =============================================================================
// VCS
// =============================================================================

export class FakeVcs implements Vcs {
  baseSha = "base-sha";
  headShaValue = "head-sha";
  mergeCommit = "merge-sha";
  mergeResult: MergeResult | null = null;
  readonly mergeResults: MergeResult[] = [];
  changedFiles: string[] = [];
  taskBranchPrefix = "task/";

  readonly ensureCleanWorkingTreeCalls: string[] = [];
  readonly checkoutCalls: Array<{ repoPath: string; branch: string }> = [];
  readonly checkoutOrCreateCalls: Array<{ repoPath: string; branch: string }> = [];
  readonly mergeCalls: Array<{
    repoPath: string;
    mainBranch: string;
    branches: TaskBranchToMerge[];
  }> = [];
  readonly listChangedCalls: Array<{ cwd: string; baseRef: string }> = [];

  async ensureCleanWorkingTree(repoPath: string): Promise<void> {
    this.ensureCleanWorkingTreeCalls.push(repoPath);
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    this.checkoutCalls.push({ repoPath, branch });
  }

  async checkoutOrCreateBranch(repoPath: string, branch: string): Promise<void> {
    this.checkoutOrCreateCalls.push({ repoPath, branch });
  }

  async resolveRunBaseSha(_repoPath: string, _mainBranch: string): Promise<string> {
    return this.baseSha;
  }

  async headSha(_repoPath: string): Promise<string> {
    return this.headShaValue;
  }

  async isAncestor(
    _repoPath: string,
    _ancestorSha: string,
    _descendantSha: string,
  ): Promise<boolean> {
    return true;
  }

  async mergeTaskBranches(opts: {
    repoPath: string;
    mainBranch: string;
    branches: TaskBranchToMerge[];
  }): Promise<MergeResult> {
    this.mergeCalls.push(opts);
    const queued = this.mergeResults.shift();
    if (queued) return queued;
    if (this.mergeResult) return this.mergeResult;
    return {
      status: "merged",
      merged: opts.branches,
      conflicts: [],
      mergeCommit: this.mergeCommit,
    };
  }

  queueMergeResult(result: MergeResult): void {
    this.mergeResults.push(result);
  }

  buildTaskBranchName(taskId: string, taskName: string): string {
    const slug = normalizeSlug(taskName);
    return `${this.taskBranchPrefix}${taskId}-${slug}`;
  }

  async listChangedFiles(cwd: string, baseRef: string): Promise<string[]> {
    this.listChangedCalls.push({ cwd, baseRef });
    return this.changedFiles;
  }
}

function normalizeSlug(input: string): string {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "task";
}

// =============================================================================
// STATE REPOSITORY
// =============================================================================

export class FakeStateRepository implements StateRepository {
  private latestRunId: string | null = null;

  constructor(private readonly paths?: PathsContext) {}

  create(projectName: string, runId: string): StateStore {
    return new StateStore(projectName, runId, this.paths);
  }

  async findLatestRunId(_projectName: string): Promise<string | null> {
    return this.latestRunId;
  }

  setLatestRunId(runId: string | null): void {
    this.latestRunId = runId;
  }
}

// =============================================================================
// LOG SINK
// =============================================================================

type LoggedEvent = {
  type: string;
  payload?: JsonObject;
  loggerPath: string;
};

export class FakeLogSink implements LogSink {
  readonly events: LoggedEvent[] = [];

  constructor(private readonly logsRoot: string) {}

  createOrchestratorLogger(projectName: string, runId: string): JsonlLogger {
    const logPath = path.join(this.logsRoot, `${projectName}-${runId}.jsonl`);
    return new JsonlLogger(logPath, { runId });
  }

  logOrchestratorEvent(logger: JsonlLogger, type: string, payload?: JsonObject): void {
    this.events.push({ type, payload, loggerPath: logger.filePath });
    logOrchestratorEvent(logger, type, payload);
  }
}

// =============================================================================
// CLOCK
// =============================================================================

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2024-01-01T00:00:00.000Z")) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  isoNow(): string {
    return this.current.toISOString();
  }

  advanceByMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = date;
  }
}
