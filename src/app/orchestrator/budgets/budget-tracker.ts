/**
 * BudgetTracker centralizes token/cost tracking and budget enforcement.
 * Purpose: update usage, log budget events, and surface stop reasons.
 * Assumptions: caller provides task results and allows state mutation.
 * Usage: const tracker = new BudgetTracker(options); tracker.recordUsageUpdates(...).
 */

import {
  detectBudgetBreaches,
  parseTaskTokenUsage,
  recomputeRunUsage,
  type BudgetBreach,
  type TaskTokenUsage,
  type TaskUsageUpdate,
} from "../../../core/budgets.js";
import type { BudgetsConfig } from "../../../core/config.js";
import { JsonlLogger, logOrchestratorEvent, type JsonObject } from "../../../core/logger.js";
import type { PathsContext } from "../../../core/paths.js";
import { taskEventsLogPath } from "../../../core/paths.js";
import type { RunState } from "../../../core/state.js";
import type { TaskSpec } from "../../../core/task-manifest.js";



// =============================================================================
// TYPES
// =============================================================================

export type RunUsageSnapshot = {
  tokensUsed: number;
  estimatedCost: number;
};

export type BudgetUsageSnapshot = {
  runUsageBefore: RunUsageSnapshot;
  runUsageAfter: RunUsageSnapshot;
  usageUpdates: TaskUsageUpdate[];
};

export type BudgetTrackingOutcome = BudgetUsageSnapshot & {
  breaches: BudgetBreach[];
  stopReason?: "budget_block";
};

export type BudgetTaskResult = {
  taskId: string;
  taskSlug: string;
};

export type BudgetEventsPathResolver = (
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
) => string;

export type TaskUsageReader = (eventsPath: string, costPer1kTokens: number) => TaskTokenUsage;

export type BudgetTrackerOptions = {
  projectName: string;
  runId: string;
  costPer1kTokens: number;
  budgets?: BudgetsConfig;
  orchestratorLog: JsonlLogger;
  resolveEventsPath?: BudgetEventsPathResolver;
  readTaskUsage?: TaskUsageReader;
  paths?: PathsContext;
};



// =============================================================================
// BUDGET TRACKER
// =============================================================================

export class BudgetTracker {
  private readonly projectName: string;
  private readonly runId: string;
  private readonly costPer1kTokens: number;
  private readonly budgets?: BudgetsConfig;
  private readonly orchestratorLog: JsonlLogger;
  private readonly resolveEventsPath: BudgetEventsPathResolver;
  private readonly readTaskUsage: TaskUsageReader;

  constructor(options: BudgetTrackerOptions) {
    this.projectName = options.projectName;
    this.runId = options.runId;
    this.costPer1kTokens = options.costPer1kTokens;
    this.budgets = options.budgets;
    this.orchestratorLog = options.orchestratorLog;
    this.resolveEventsPath =
      options.resolveEventsPath ??
      ((projectName, runId, taskId, taskSlug) =>
        taskEventsLogPath(projectName, runId, taskId, taskSlug, options.paths));
    this.readTaskUsage = options.readTaskUsage ?? parseTaskTokenUsage;
  }

  recordUsageUpdates(input: {
    state: RunState;
    taskResults: BudgetTaskResult[];
  }): BudgetUsageSnapshot {
    const runUsageBefore = this.snapshotRunUsage(input.state);
    const usageUpdates: TaskUsageUpdate[] = [];

    for (const result of input.taskResults) {
      const update = this.refreshTaskUsage(input.state, result);
      if (update) {
        usageUpdates.push(update);
      }
    }

    const runUsageAfter = recomputeRunUsage(input.state);
    return { runUsageBefore, runUsageAfter, usageUpdates };
  }

  evaluateBreaches(input: {
    state: RunState;
    snapshot: BudgetUsageSnapshot;
  }): BudgetTrackingOutcome {
    const breaches = detectBudgetBreaches({
      budgets: this.budgets,
      taskUpdates: input.snapshot.usageUpdates,
      runBefore: input.snapshot.runUsageBefore,
      runAfter: input.snapshot.runUsageAfter,
    });
    const stopReason = breaches.length > 0 ? this.logBudgetBreaches(breaches) : undefined;

    if (stopReason) {
      input.state.status = "failed";
    }

    return { ...input.snapshot, breaches, stopReason };
  }

  applyUsageForResults(input: {
    state: RunState;
    taskResults: BudgetTaskResult[];
  }): BudgetTrackingOutcome {
    const snapshot = this.recordUsageUpdates(input);
    return this.evaluateBreaches({ state: input.state, snapshot });
  }

  backfillUsageFromLogs(input: { tasks: TaskSpec[]; state: RunState }): boolean {
    let updated = false;
    const runUsageBefore = this.snapshotRunUsage(input.state);

    for (const task of input.tasks) {
      const taskState = input.state.tasks[task.manifest.id];
      if (!taskState) continue;

      const hasUsage =
        (taskState.tokens_used ?? 0) > 0 ||
        (taskState.usage_by_attempt && taskState.usage_by_attempt.length > 0);
      if (hasUsage) continue;

      const update = this.refreshTaskUsage(input.state, {
        taskId: task.manifest.id,
        taskSlug: task.slug,
      });
      if (update) {
        updated = true;
      }
    }

    const runUsageAfter = recomputeRunUsage(input.state);
    if (
      runUsageAfter.tokensUsed !== runUsageBefore.tokensUsed ||
      runUsageAfter.estimatedCost !== runUsageBefore.estimatedCost
    ) {
      updated = true;
    }

    return updated;
  }

  private snapshotRunUsage(state: RunState): RunUsageSnapshot {
    return {
      tokensUsed: state.tokens_used ?? 0,
      estimatedCost: state.estimated_cost ?? 0,
    };
  }

  private refreshTaskUsage(
    state: RunState,
    input: BudgetTaskResult,
  ): TaskUsageUpdate | null {
    const taskState = state.tasks[input.taskId];
    if (!taskState) return null;

    const previousTokens = taskState.tokens_used ?? 0;
    const previousCost = taskState.estimated_cost ?? 0;
    const eventsPath = this.resolveEventsPath(
      this.projectName,
      this.runId,
      input.taskId,
      input.taskSlug,
    );
    const usage = this.readTaskUsage(eventsPath, this.costPer1kTokens);

    taskState.usage_by_attempt = usage.attempts;
    taskState.tokens_used = usage.tokensUsed;
    taskState.estimated_cost = usage.estimatedCost;

    return { taskId: input.taskId, previousTokens, previousCost, usage };
  }

  private logBudgetBreaches(breaches: BudgetBreach[]): "budget_block" | undefined {
    let stop: "budget_block" | undefined;

    for (const breach of breaches) {
      const payload: JsonObject = {
        scope: breach.scope,
        kind: breach.kind,
        limit: breach.limit,
        value: breach.value,
        mode: breach.mode,
      };
      if (breach.taskId) {
        payload.task_id = breach.taskId;
      }

      const eventType = breach.mode === "block" ? "budget.block" : "budget.warn";
      logOrchestratorEvent(this.orchestratorLog, eventType, payload);

      if (breach.mode === "block") {
        stop = "budget_block";
      }
    }

    return stop;
  }
}
