/**
 * WorkerRunner interface for orchestrator worker execution.
 * Purpose: unify Docker and local workers behind explicit inputs/outputs.
 * Assumptions: the executor prepares workspaces and owns run state updates.
 * Usage: instantiate a runner and call runAttempt/resumeAttempt/stop/cleanupTask.
 */

import type { JsonlLogger } from "../../../core/logger.js";

// =============================================================================
// TYPES
// =============================================================================

export type WorkerRunAttemptInput = {
  taskId: string;
  taskSlug: string;
  taskBranch: string;
  workspace: string;
  taskPaths: {
    manifestPath: string;
    specPath: string;
    taskRelativeDirPosix: string;
  };
  lintCommand?: string;
  lintTimeoutSeconds?: number;
  doctorCommand: string;
  doctorTimeoutSeconds?: number;
  maxRetries: number;
  bootstrapCmds: string[];
  runLogsDir: string;
  codexHome: string;
  codexModel?: string;
  codexModelReasoningEffort?: string;
  checkpointCommits: boolean;
  defaultTestPaths?: string[];
  logCodexPrompts: boolean;
  crashAfterStart?: boolean;
  taskEvents: JsonlLogger;
  orchestratorLogger: JsonlLogger;
  onContainerReady?: (containerId: string) => Promise<void> | void;
};

export type WorkerPrepareInput = {
  buildImage: boolean;
  orchestratorLogger: JsonlLogger;
};

export type WorkerResumeAttemptInput = {
  taskId: string;
  taskSlug: string;
  workspace: string;
  containerIdHint?: string;
  taskEvents: JsonlLogger;
  orchestratorLogger: JsonlLogger;
};

export type WorkerRunnerResult = {
  success: boolean;
  errorMessage?: string;
  resetToPending?: boolean;
  containerId?: string;
};

export type WorkerStopInput = {
  stopContainersOnExit: boolean;
  orchestratorLogger: JsonlLogger;
};

export type WorkerStopResult = {
  stopped: number;
  errors: number;
};

export type WorkerCleanupInput = {
  taskId: string;
  containerIdHint?: string;
  orchestratorLogger: JsonlLogger;
};

export type WorkerRunner = {
  prepare(input: WorkerPrepareInput): Promise<void>;
  runAttempt(input: WorkerRunAttemptInput): Promise<WorkerRunnerResult>;
  resumeAttempt(input: WorkerResumeAttemptInput): Promise<WorkerRunnerResult>;
  stop(input: WorkerStopInput): Promise<WorkerStopResult | null>;
  cleanupTask(input: WorkerCleanupInput): Promise<void>;
};
