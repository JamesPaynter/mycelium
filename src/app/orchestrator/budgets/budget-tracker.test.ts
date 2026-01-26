/**
 * BudgetTracker unit tests.
 * Purpose: verify usage updates and budget block decisions.
 * Assumptions: usage events are provided via a test resolver.
 * Usage: npm test -- src/app/orchestrator/budgets/budget-tracker.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlLogger } from "../../../core/logger.js";
import { createRunState } from "../../../core/state.js";
import type { TaskSpec } from "../../../core/task-manifest.js";

import { BudgetTracker } from "./budget-tracker.js";

// =============================================================================
// HELPERS
// =============================================================================

function buildTaskSpec(id: string, name: string): TaskSpec {
  return {
    manifest: {
      id,
      name,
      description: "budget tracker test task",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    },
    taskDirName: `${id}-${name}`,
    stage: "legacy",
    slug: name,
  };
}

function buildUsageEvents(): string {
  const lines = [
    {
      ts: "2024-01-01T00:00:00Z",
      type: "codex.event",
      attempt: 1,
      payload: {
        event: {
          type: "turn.completed",
          usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  ];

  return lines.map((line) => JSON.stringify(line)).join("\n");
}

// =============================================================================
// TESTS
// =============================================================================

describe("BudgetTracker", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "budget-tracker-"));
    eventsPath = path.join(tmpDir, "events.jsonl");
    await fs.writeFile(eventsPath, buildUsageEvents(), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("updates usage and emits budget block when limits are exceeded", () => {
    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), {
      runId: "run-1",
    });

    try {
      const state = createRunState({
        runId: "run-1",
        project: "demo",
        repoPath: tmpDir,
        mainBranch: "main",
        taskIds: ["001"],
      });

      const tracker = new BudgetTracker({
        projectName: "demo",
        runId: "run-1",
        costPer1kTokens: 1,
        budgets: { max_tokens_per_task: 1, mode: "block" },
        orchestratorLog,
        resolveEventsPath: () => eventsPath,
      });

      const outcome = tracker.applyUsageForResults({
        state,
        taskResults: [{ taskId: "001", taskSlug: "budget-task" }],
      });

      expect(outcome.breaches).toHaveLength(1);
      expect(outcome.stopReason).toBe("budget_block");
      expect(state.tasks["001"]?.tokens_used).toBeGreaterThan(1);
      expect(state.status).toBe("failed");
    } finally {
      orchestratorLog.close();
    }
  });

  it("backfills missing usage from logs", () => {
    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), {
      runId: "run-2",
    });

    try {
      const state = createRunState({
        runId: "run-2",
        project: "demo",
        repoPath: tmpDir,
        mainBranch: "main",
        taskIds: ["002"],
      });

      const tracker = new BudgetTracker({
        projectName: "demo",
        runId: "run-2",
        costPer1kTokens: 1,
        budgets: undefined,
        orchestratorLog,
        resolveEventsPath: () => eventsPath,
      });

      const updated = tracker.backfillUsageFromLogs({
        state,
        tasks: [buildTaskSpec("002", "backfill-task")],
      });

      expect(updated).toBe(true);
      expect(state.tasks["002"]?.usage_by_attempt.length).toBeGreaterThan(0);
      expect(state.tokens_used).toBeGreaterThan(0);
    } finally {
      orchestratorLog.close();
    }
  });
});
