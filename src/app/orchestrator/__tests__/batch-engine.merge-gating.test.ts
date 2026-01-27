/**
 * BatchEngine merge gating tests.
 * Purpose: ensure temp merge + integration doctor gating controls fast-forwarding main.
 * Assumptions: fakes provide deterministic VCS and worker behavior.
 * Usage: npm test -- src/app/orchestrator/__tests__/batch-engine.merge-gating.test.ts
 */

import fse from "fs-extra";
import { describe, expect, it } from "vitest";

import { resolveTaskArchivePath, resolveTaskDir } from "../../../core/task-layout.js";
import { loadTaskLedger } from "../../../core/task-ledger.js";

import { setupBatchEngineFixture } from "./batch-engine.merge-gating.fixtures.js";

// =============================================================================
// TESTS
// =============================================================================

describe("BatchEngine merge gating", () => {
  it("does not fast-forward when integration doctor fails", async () => {
    const fixture = await setupBatchEngineFixture({
      doctorCommand: 'node -e "process.exit(1)"',
    });

    try {
      const stopReason = await fixture.batchEngine.finalizeBatch({
        batchId: fixture.batchId,
        batchTasks: fixture.batchTasks,
        results: fixture.results,
      });

      expect(stopReason).toBe("integration_doctor_failed");
      expect(fixture.fakeVcs.tempMergeCalls).toHaveLength(1);
      expect(fixture.fakeVcs.fastForwardCalls).toHaveLength(0);
      expect(fixture.state.status).toBe("failed");
      expect(fixture.state.tasks[fixture.taskId]?.status).toBe("needs_human_review");

      const ledger = await loadTaskLedger(fixture.projectName, fixture.paths);
      expect(ledger).toBeNull();

      const activePath = resolveTaskDir({
        tasksRoot: fixture.tasksRoot,
        stage: fixture.taskStage,
        taskDirName: fixture.taskDirName,
      });
      const archivePath = resolveTaskArchivePath({
        tasksRoot: fixture.tasksRoot,
        runId: fixture.runId,
        taskDirName: fixture.taskDirName,
      });

      expect(await fse.pathExists(activePath)).toBe(true);
      expect(await fse.pathExists(archivePath)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fast-forwards and completes tasks after integration doctor passes", async () => {
    const fixture = await setupBatchEngineFixture({
      doctorCommand: 'node -e "process.exit(0)"',
    });

    try {
      const stopReason = await fixture.batchEngine.finalizeBatch({
        batchId: fixture.batchId,
        batchTasks: fixture.batchTasks,
        results: fixture.results,
      });

      expect(stopReason).toBeUndefined();
      expect(fixture.fakeVcs.tempMergeCalls).toHaveLength(1);
      expect(fixture.fakeVcs.fastForwardCalls).toHaveLength(1);
      expect(fixture.state.tasks[fixture.taskId]?.status).toBe("complete");

      const ledger = await loadTaskLedger(fixture.projectName, fixture.paths);
      expect(ledger?.tasks[fixture.taskId]?.integrationDoctorPassed).toBe(true);
      expect(ledger?.tasks[fixture.taskId]?.mergeCommit).toBe(fixture.fakeVcs.mergeCommit);

      const activePath = resolveTaskDir({
        tasksRoot: fixture.tasksRoot,
        stage: fixture.taskStage,
        taskDirName: fixture.taskDirName,
      });
      const archivePath = resolveTaskArchivePath({
        tasksRoot: fixture.tasksRoot,
        runId: fixture.runId,
        taskDirName: fixture.taskDirName,
      });

      expect(await fse.pathExists(activePath)).toBe(false);
      expect(await fse.pathExists(archivePath)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
