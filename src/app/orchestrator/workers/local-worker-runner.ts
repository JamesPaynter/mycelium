/**
 * LocalWorkerRunner executes the worker loop directly in-process.
 * Purpose: keep local execution aligned with Docker logging semantics.
 * Assumptions: workspace preparation is done by the executor.
 * Usage: new LocalWorkerRunner().runAttempt(...)
 */

import type { WorkerLogEventInput, WorkerLogger } from "../../../../worker/logging.js";
import { runWorker } from "../../../../worker/loop.js";
import { logJsonLineOrRaw, logOrchestratorEvent, type JsonlLogger } from "../../../core/logger.js";
import { isoNow } from "../../../core/utils.js";

import type {
  WorkerCleanupInput,
  WorkerPrepareInput,
  WorkerResumeAttemptInput,
  WorkerRunAttemptInput,
  WorkerRunner,
  WorkerRunnerResult,
  WorkerStopInput,
  WorkerStopResult,
} from "./worker-runner.js";


// =============================================================================
// RUNNER
// =============================================================================

export class LocalWorkerRunner implements WorkerRunner {
  async prepare(_input: WorkerPrepareInput): Promise<void> {
    // No-op for local execution.
  }

  async runAttempt(input: WorkerRunAttemptInput): Promise<WorkerRunnerResult> {
    logOrchestratorEvent(input.orchestratorLogger, "worker.local.start", {
      taskId: input.taskId,
      workspace: input.workspace,
    });

    const workerLogger = createLocalWorkerLogger(input.taskEvents, {
      taskId: input.taskId,
      taskSlug: input.taskSlug,
    });

    try {
      await runWorker(
        {
          taskId: input.taskId,
          taskSlug: input.taskSlug,
          taskBranch: input.taskBranch,
          manifestPath: input.taskPaths.manifestPath,
          specPath: input.taskPaths.specPath,
          lintCmd: input.lintCommand,
          lintTimeoutSeconds: input.lintTimeoutSeconds,
          doctorCmd: input.doctorCommand,
          doctorTimeoutSeconds: input.doctorTimeoutSeconds,
          maxRetries: input.maxRetries,
          bootstrapCmds: input.bootstrapCmds,
          runLogsDir: input.runLogsDir,
          codexHome: input.codexHome,
          codexModel: input.codexModel,
          workingDirectory: input.workspace,
          checkpointCommits: input.checkpointCommits,
          defaultTestPaths: input.defaultTestPaths,
          logCodexPrompts: input.logCodexPrompts,
        },
        workerLogger,
      );

      logOrchestratorEvent(input.orchestratorLogger, "worker.local.complete", {
        taskId: input.taskId,
      });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logOrchestratorEvent(input.orchestratorLogger, "worker.local.error", {
        taskId: input.taskId,
        message,
      });
      return { success: false, errorMessage: message };
    }
  }

  async resumeAttempt(_input: WorkerResumeAttemptInput): Promise<WorkerRunnerResult> {
    const reason = "Docker unavailable on resume; resetting running task to pending";
    return { success: false, errorMessage: reason, resetToPending: true };
  }

  async stop(_input: WorkerStopInput): Promise<WorkerStopResult | null> {
    return null;
  }

  async cleanupTask(_input: WorkerCleanupInput): Promise<void> {
    // No-op for local execution.
  }
}


// =============================================================================
// LOGGING
// =============================================================================

function createLocalWorkerLogger(
  taskEvents: JsonlLogger,
  defaults: { taskId: string; taskSlug: string },
): WorkerLogger {
  return {
    log(event: WorkerLogEventInput) {
      const normalized = normalizeWorkerEvent(event, defaults);
      logJsonLineOrRaw(taskEvents, JSON.stringify(normalized), "stdout", "task.log");
    },
  };
}

function normalizeWorkerEvent(
  event: WorkerLogEventInput,
  defaults: { taskId: string; taskSlug: string },
): Record<string, unknown> {
  const ts =
    typeof event.ts === "string"
      ? event.ts
      : event.ts instanceof Date
        ? event.ts.toISOString()
        : isoNow();

  const payload =
    event.payload && Object.keys(event.payload).length > 0 ? event.payload : undefined;

  const normalized: Record<string, unknown> = {
    ts,
    type: event.type,
  };

  if (event.attempt !== undefined) normalized.attempt = event.attempt;

  const taskId = event.taskId ?? defaults.taskId;
  if (taskId) normalized.task_id = taskId;

  const taskSlug = event.taskSlug ?? defaults.taskSlug;
  if (taskSlug) normalized.task_slug = taskSlug;

  if (payload) normalized.payload = payload;

  return normalized;
}
