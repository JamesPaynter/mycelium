import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectBudgetBreaches, parseTaskTokenUsage } from "./budgets.js";

describe("parseTaskTokenUsage", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = "";
  });

  it("aggregates turn.completed usage by attempt", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budgets-"));
    const eventsPath = path.join(tmpDir, "events.jsonl");
    const lines = [
      {
        ts: "2024-01-01T00:00:00Z",
        type: "codex.event",
        attempt: 1,
        payload: {
          event: {
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:05Z",
        type: "codex.event",
        attempt: 1,
        payload: {
          event: {
            type: "turn.completed",
            usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1 },
          },
        },
      },
      {
        ts: "2024-01-01T00:01:00Z",
        type: "codex.event",
        attempt: 2,
        payload: {
          event: {
            type: "turn.completed",
            usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 },
          },
        },
      },
      { ts: "2024-01-01T00:02:00Z", type: "task.log", payload: { raw: "ignore" } },
    ];
    fs.writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

    const usage = parseTaskTokenUsage(eventsPath, 1);

    expect(usage.tokensUsed).toBe(28);
    expect(usage.estimatedCost).toBeCloseTo(0.028, 5);
    expect(usage.attempts).toEqual([
      {
        attempt: 1,
        input_tokens: 13,
        cached_input_tokens: 2,
        output_tokens: 6,
        total_tokens: 21,
        estimated_cost: 0.021,
      },
      {
        attempt: 2,
        input_tokens: 4,
        cached_input_tokens: 1,
        output_tokens: 2,
        total_tokens: 7,
        estimated_cost: 0.007,
      },
    ]);
  });
});

describe("detectBudgetBreaches", () => {
  it("flags task and run crossings only when thresholds are exceeded", () => {
    const breaches = detectBudgetBreaches({
      budgets: { max_tokens_per_task: 20, max_cost_per_run: 0.05, mode: "block" },
      taskUpdates: [
        {
          taskId: "001",
          previousTokens: 10,
          previousCost: 0.01,
          usage: { attempts: [], tokensUsed: 25, estimatedCost: 0.03 },
        },
        {
          taskId: "002",
          previousTokens: 25,
          previousCost: 0.02,
          usage: { attempts: [], tokensUsed: 25, estimatedCost: 0.03 },
        },
      ],
      runBefore: { tokensUsed: 40, estimatedCost: 0.02 },
      runAfter: { tokensUsed: 60, estimatedCost: 0.06 },
    });

    expect(breaches).toEqual([
      { scope: "task", kind: "tokens", mode: "block", taskId: "001", limit: 20, value: 25 },
      { scope: "run", kind: "cost", mode: "block", limit: 0.05, value: 0.06 },
    ]);
  });

  it("returns no breaches when budgets are absent", () => {
    const breaches = detectBudgetBreaches({
      budgets: undefined,
      taskUpdates: [],
      runBefore: { tokensUsed: 0, estimatedCost: 0 },
      runAfter: { tokensUsed: 100, estimatedCost: 10 },
    });

    expect(breaches).toEqual([]);
  });
});
