import { describe, expect, it } from "vitest";

import { summarizeRunState } from "./state-store.js";
import { createRunState } from "./state.js";

describe("summarizeRunState", () => {
  it("includes human review queue entries and validator counts", () => {
    const state = createRunState({
      runId: "run-1",
      project: "demo",
      repoPath: "/tmp/demo",
      mainBranch: "main",
      taskIds: ["001", "002"],
    });

    state.tasks["001"].status = "complete";
    state.tasks["001"].validator_results = [
      {
        validator: "test",
        status: "pass",
        mode: "warn",
        summary: "ok",
        report_path: "validators/test-validator/001-task.json",
      },
    ];

    state.tasks["002"].status = "needs_human_review";
    state.tasks["002"].validator_results = [
      {
        validator: "test",
        status: "fail",
        mode: "block",
        summary: "flaky tests",
        report_path: "validators/test-validator/002-task.json",
      },
    ];
    state.tasks["002"].human_review = {
      validator: "test",
      reason: "Validator blocked merge",
      summary: "flaky tests",
      report_path: "validators/test-validator/002-task.json",
    };
    state.tasks["001"].tokens_used = 500;
    state.tasks["001"].estimated_cost = 1.25;
    state.tokens_used = 500;
    state.estimated_cost = 1.25;

    const summary = summarizeRunState(state);
    expect(summary.taskCounts.needs_human_review).toBe(1);
    expect(summary.taskCounts.complete).toBe(1);
    expect(summary.tokensUsed).toBe(500);
    expect(summary.estimatedCost).toBe(1.25);
    expect(summary.humanReview).toEqual([
      {
        id: "002",
        validator: "test",
        reason: "Validator blocked merge",
        summary: "flaky tests",
        reportPath: "validators/test-validator/002-task.json",
      },
    ]);
    expect(summary.topSpenders).toEqual([{ id: "001", tokensUsed: 500, estimatedCost: 1.25 }]);
  });
});
