import fs from "node:fs";

import type { BudgetsConfig } from "./config.js";
import type { AttemptUsage, RunState } from "./state.js";

// =============================================================================
// CONSTANTS
// =============================================================================

// Approximate cost per 1K tokens; adjust here when pricing changes.
export const DEFAULT_COST_PER_1K_TOKENS = 0.002;

// =============================================================================
// TYPES
// =============================================================================

export type TaskTokenUsage = {
  attempts: AttemptUsage[];
  tokensUsed: number;
  estimatedCost: number;
};

export type TaskUsageUpdate = {
  taskId: string;
  previousTokens: number;
  previousCost: number;
  usage: TaskTokenUsage;
};

export type BudgetBreach = {
  scope: "task" | "run";
  kind: "tokens" | "cost";
  mode: "warn" | "block";
  taskId?: string;
  limit: number;
  value: number;
};

// =============================================================================
// TOKEN ACCOUNTING
// =============================================================================

export function parseTaskTokenUsage(
  eventsPath: string,
  costPer1kTokens: number = DEFAULT_COST_PER_1K_TOKENS,
): TaskTokenUsage {
  if (!fs.existsSync(eventsPath)) {
    return emptyUsage();
  }

  const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/);
  const attempts = new Map<number, { input: number; cached: number; output: number }>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = safeParseJson(line);
    if (!parsed || parsed.type !== "codex.event") continue;

    const usage = extractUsage(parsed);
    if (!usage) continue;

    const attempt = typeof parsed.attempt === "number" ? parsed.attempt : 0;
    const bucket = attempts.get(attempt) ?? { input: 0, cached: 0, output: 0 };

    bucket.input += usage.input_tokens;
    bucket.cached += usage.cached_input_tokens;
    bucket.output += usage.output_tokens;

    attempts.set(attempt, bucket);
  }

  const attemptUsage: AttemptUsage[] = Array.from(attempts.entries())
    .map(([attempt, totals]) => {
      const totalTokens = totals.input + totals.cached + totals.output;
      return {
        attempt,
        input_tokens: totals.input,
        cached_input_tokens: totals.cached,
        output_tokens: totals.output,
        total_tokens: totalTokens,
        estimated_cost: estimateCostFromTokens(totalTokens, costPer1kTokens),
      };
    })
    .sort((a, b) => a.attempt - b.attempt);

  const tokensUsed = attemptUsage.reduce((sum, usage) => sum + usage.total_tokens, 0);
  const estimatedCost = estimateCostFromTokens(tokensUsed, costPer1kTokens);

  return { attempts: attemptUsage, tokensUsed, estimatedCost };
}

export function recomputeRunUsage(state: RunState): { tokensUsed: number; estimatedCost: number } {
  const tokensUsed = Object.values(state.tasks).reduce(
    (sum, task) => sum + (task.tokens_used ?? 0),
    0,
  );
  const estimatedCost = Object.values(state.tasks).reduce(
    (sum, task) => sum + (task.estimated_cost ?? 0),
    0,
  );

  state.tokens_used = tokensUsed;
  state.estimated_cost = roundCurrency(estimatedCost);

  return { tokensUsed, estimatedCost: state.estimated_cost };
}

// =============================================================================
// BUDGETS
// =============================================================================

export function detectBudgetBreaches(args: {
  budgets?: BudgetsConfig;
  taskUpdates: TaskUsageUpdate[];
  runBefore: { tokensUsed: number; estimatedCost: number };
  runAfter: { tokensUsed: number; estimatedCost: number };
}): BudgetBreach[] {
  const cfg = args.budgets;
  if (!cfg) return [];

  const breaches: BudgetBreach[] = [];
  const mode = cfg.mode ?? "warn";

  if (cfg.max_tokens_per_task !== undefined) {
    for (const update of args.taskUpdates) {
      if (
        update.previousTokens <= cfg.max_tokens_per_task &&
        update.usage.tokensUsed > cfg.max_tokens_per_task
      ) {
        breaches.push({
          scope: "task",
          kind: "tokens",
          mode,
          taskId: update.taskId,
          limit: cfg.max_tokens_per_task,
          value: update.usage.tokensUsed,
        });
      }
    }
  }

  if (cfg.max_cost_per_run !== undefined) {
    const before = args.runBefore.estimatedCost ?? 0;
    const after = args.runAfter.estimatedCost ?? 0;
    if (before <= cfg.max_cost_per_run && after > cfg.max_cost_per_run) {
      breaches.push({
        scope: "run",
        kind: "cost",
        mode,
        limit: cfg.max_cost_per_run,
        value: after,
      });
    }
  }

  return breaches;
}

// =============================================================================
// INTERNALS
// =============================================================================

function extractUsage(
  event: Record<string, unknown>,
): { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const codexEvent = (payload as { event?: unknown }).event;
  if (!codexEvent || typeof codexEvent !== "object" || Array.isArray(codexEvent)) return null;

  const typed = codexEvent as Record<string, unknown>;
  if (typed.type !== "turn.completed") return null;

  const usage = typed.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const inputTokens = numberOrZero((usage as { input_tokens?: unknown }).input_tokens);
  const cachedTokens = numberOrZero((usage as { cached_input_tokens?: unknown }).cached_input_tokens);
  const outputTokens = numberOrZero((usage as { output_tokens?: unknown }).output_tokens);

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
  };
}

function estimateCostFromTokens(tokens: number, costPer1kTokens: number): number {
  const cost = (tokens / 1000) * costPer1kTokens;
  return roundCurrency(cost);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function emptyUsage(): TaskTokenUsage {
  return {
    attempts: [],
    tokensUsed: 0,
    estimatedCost: 0,
  };
}
