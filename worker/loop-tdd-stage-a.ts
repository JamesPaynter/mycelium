import { isTestPath } from "../src/core/test-paths.js";

import type { BootstrapCommandSummary, PromptKind } from "./attempt-summary.js";
import type { CodexRunnerLike } from "./codex.js";
import type { WorkerLogger } from "./logging.js";
import { runCodexTurn } from "./loop-codex.js";
import { DOCTOR_PROMPT_LIMIT, OUTPUT_PREVIEW_LIMIT } from "./loop-constants.js";
import { maybeCheckpointCommit } from "./loop-git.js";
import { diffChangedPaths, filterInternalChanges, listChangedPaths } from "./loop-io.js";
import { buildInitialPrompt } from "./loop-prompts.js";
import { buildCommandsSummary, recordAttemptSummary } from "./loop-reporting.js";
import {
  getStageASkipReason,
  handleStageAFastResult,
  handleStageANonTestChanges,
  recordStageACodexFailure,
  runFastCommand,
} from "./loop-tdd-stage-a-helpers.js";
import type { TaskManifest } from "./loop.js";
import { WorkerStateStore } from "./state.js";

// =============================================================================
// STRICT TDD STAGE A
// =============================================================================

type StrictTddStageAResult =
  | {
      status: "ready";
      nextAttempt: number;
      fastOutput: string;
      loggedResumeEvent: boolean;
      promptSummary: string;
      bootstrapConsumed: boolean;
    }
  | {
      status: "retry";
      nextAttempt: number;
      loggedResumeEvent: boolean;
      promptSummary: string;
      bootstrapConsumed: boolean;
    }
  | { status: "skipped"; reason: string; loggedResumeEvent: boolean };

export async function runStrictTddStageA(args: {
  attempt: number;
  promptKind: PromptKind;
  lastAttemptSummary?: string | null;
  taskId: string;
  manifest: TaskManifest;
  manifestPath: string;
  spec: string;
  taskBranch?: string;
  codex: CodexRunnerLike;
  workerState: WorkerStateStore;
  log: WorkerLogger;
  loggedResumeEvent: boolean;
  logCodexPrompts: boolean;
  workingDirectory: string;
  checkpointCommits: boolean;
  testPaths: string[];
  fastCommand?: string;
  doctorTimeoutSeconds?: number;
  runLogsDir: string;
  commandEnv: NodeJS.ProcessEnv;
  declaredWriteGlobs: string[];
  bootstrapResults?: BootstrapCommandSummary[];
}): Promise<StrictTddStageAResult> {
  const skipReason = getStageASkipReason(args.fastCommand, args.testPaths);
  if (skipReason) {
    args.log.log({
      type: "tdd.stage.skip",
      attempt: args.attempt,
      payload: { stage: "A", reason: skipReason },
    });
    return { status: "skipped", reason: skipReason, loggedResumeEvent: args.loggedResumeEvent };
  }
  const fastCommand = args.fastCommand?.trim() ?? "";

  args.log.log({
    type: "tdd.stage.start",
    attempt: args.attempt,
    payload: { stage: "A", mode: "strict", test_paths: args.testPaths },
  });

  const beforeChanges = await listChangedPaths(args.workingDirectory);

  const prompt = buildInitialPrompt({
    spec: args.spec,
    manifest: args.manifest,
    manifestPath: args.manifestPath,
    taskBranch: args.taskBranch,
    lastAttemptSummary: args.lastAttemptSummary,
    declaredWriteGlobs: args.declaredWriteGlobs,
    strictTddContext: { stage: "tests", testPaths: args.testPaths },
  });

  let loggedResumeEvent = args.loggedResumeEvent;
  let codexError: unknown = null;
  try {
    loggedResumeEvent = await runCodexTurn({
      attempt: args.attempt,
      codex: args.codex,
      log: args.log,
      workerState: args.workerState,
      loggedResumeEvent,
      logCodexPrompts: args.logCodexPrompts,
      prompt,
      runLogsDir: args.runLogsDir,
    });
  } catch (err) {
    codexError = err;
  }

  const bootstrapConsumed = Boolean(args.bootstrapResults?.length);
  const commandSummary = buildCommandsSummary({ bootstrap: args.bootstrapResults });

  if (codexError) {
    const summaryResult = await recordStageACodexFailure({
      attempt: args.attempt,
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      error: codexError,
      commands: commandSummary,
    });

    return {
      status: "retry",
      nextAttempt: args.attempt + 1,
      loggedResumeEvent,
      promptSummary: summaryResult.promptSummary,
      bootstrapConsumed,
    };
  }

  const afterChanges = await listChangedPaths(args.workingDirectory);
  const newChanges = diffChangedPaths(beforeChanges, afterChanges);
  const filteredChanges = filterInternalChanges(newChanges, args.workingDirectory, args.runLogsDir);
  const currentChanges = filterInternalChanges(
    afterChanges,
    args.workingDirectory,
    args.runLogsDir,
  );
  const nonTestChanges = currentChanges.filter((file) => !isTestPath(file, args.testPaths));

  if (nonTestChanges.length > 0) {
    return handleStageANonTestChanges({
      attempt: args.attempt,
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      files: nonTestChanges,
      commands: commandSummary,
      loggedResumeEvent,
      bootstrapConsumed,
    });
  }

  const fastResult = await runFastCommand({
    attempt: args.attempt,
    command: fastCommand,
    cwd: args.workingDirectory,
    timeoutSeconds: args.doctorTimeoutSeconds,
    env: args.commandEnv,
    runLogsDir: args.runLogsDir,
  });

  const fastRetry = await handleStageAFastResult({
    attempt: args.attempt,
    promptKind: args.promptKind,
    declaredWriteGlobs: args.declaredWriteGlobs,
    runLogsDir: args.runLogsDir,
    workingDirectory: args.workingDirectory,
    log: args.log,
    fast: fastResult,
    commands: commandSummary,
    loggedResumeEvent,
    bootstrapConsumed,
  });

  if (fastRetry) {
    return fastRetry;
  }

  args.log.log({
    type: "tdd.stage.pass",
    attempt: args.attempt,
    payload: {
      stage: "A",
      mode: "strict",
      exit_code: fastResult.exitCode,
      files_changed: filteredChanges.length,
    },
  });

  const summaryResult = await recordAttemptSummary({
    attempt: args.attempt,
    phase: "tdd_stage_a",
    promptKind: args.promptKind,
    declaredWriteGlobs: args.declaredWriteGlobs,
    runLogsDir: args.runLogsDir,
    workingDirectory: args.workingDirectory,
    log: args.log,
    tdd: {
      fast_exit_code: fastResult.exitCode,
      fast_output_preview: fastResult.output.slice(0, OUTPUT_PREVIEW_LIMIT),
    },
    commands: commandSummary,
  });

  if (args.checkpointCommits) {
    await maybeCheckpointCommit({
      cwd: args.workingDirectory,
      taskId: args.taskId,
      attempt: args.attempt,
      log: args.log,
      workerState: args.workerState,
    });
  } else {
    args.log.log({
      type: "git.checkpoint.skip",
      attempt: args.attempt,
      payload: { reason: "disabled" },
    });
  }

  return {
    status: "ready",
    nextAttempt: args.attempt + 1,
    fastOutput: fastResult.output.slice(0, DOCTOR_PROMPT_LIMIT),
    loggedResumeEvent,
    promptSummary: summaryResult.promptSummary,
    bootstrapConsumed,
  };
}
