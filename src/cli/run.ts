import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { formatErrorMessage } from "../core/error-format.js";
import {
  ConfigError,
  DockerError,
  GitError,
  TaskError,
  type UserFacingErrorCode,
  UserFacingError,
  USER_FACING_ERROR_CODES,
} from "../core/errors.js";
import { runProject, type BatchPlanEntry, type RunOptions } from "../core/executor.js";
import { findLatestPausedRunId, loadRunStateForProject } from "../core/state-store.js";
import { defaultRunId } from "../core/utils.js";

import { resolveRunDebugFlags } from "./run-flags.js";
import { createRunStopSignalHandler } from "./signal-handlers.js";
import {
  closeUiServer,
  launchUiServer,
  maybeOpenUiBrowser,
  resolveUiRuntimeConfig,
  type UiStartResult,
} from "./ui.js";

type RunCommandOptions = RunOptions & {
  ui?: boolean;
  uiPort?: number;
  uiOpen?: boolean;
};

export async function runCommand(
  projectName: string,
  config: ProjectConfig,
  opts: RunCommandOptions,
  appContext?: AppContext,
): Promise<void> {
  try {
    const { ui, uiPort, uiOpen, runId: requestedRunId, resume: resumeFlag, ...runOptions } = opts;
    const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
    const runDebugFlags = resolveRunDebugFlags({
      useLegacyEngine: runOptions.useLegacyEngine,
      crashAfterContainerStart: runOptions.crashAfterContainerStart,
    });
    const uiRuntime = resolveUiRuntimeConfig(config.ui, {
      enabled: ui,
      port: uiPort,
      openBrowser: uiOpen,
    });

    let runId = requestedRunId;
    let resume = resumeFlag ?? false;

    if (!runId) {
      const pausedRunId = await findLatestPausedRunId(projectName, paths);
      if (pausedRunId) {
        runId = pausedRunId;
        resume = true;
        console.log(`Resuming paused run ${runId} (latest paused).`);
      } else {
        runId = defaultRunId();
      }
    } else {
      const resolved = await loadRunStateForProject(projectName, runId, paths);
      if (resolved?.state.status === "paused" && !resume) {
        resume = true;
        console.log(`Resuming paused run ${runId}.`);
      }
    }

    const stopHandler = createRunStopSignalHandler({
      onSignal: (signal) => {
        const containerNote = runOptions.stopContainersOnExit
          ? "Stopping task containers before exit."
          : "Leaving task containers running so you can resume.";
        console.log(
          `Received ${signal}. Stopping run ${runId}. ${containerNote} Resume with: mycelium resume --project ${projectName} --run-id ${runId}`,
        );
      },
    });

    let uiStart: UiStartResult | null = null;
    let res: Awaited<ReturnType<typeof runProject>>;
    try {
      uiStart = await launchUiServer({
        projectName,
        runId,
        runtime: uiRuntime,
        onError: "warn",
        appContext,
      });
      if (uiStart) {
        console.log(`UI: ${uiStart.url}`);
        await maybeOpenUiBrowser(uiStart.url, uiRuntime.openBrowser);
      }

      res = await runProject(
        projectName,
        config,
        {
          ...runOptions,
          ...runDebugFlags,
          runId,
          resume,
          stopSignal: stopHandler.signal,
        },
        paths,
      );
    } finally {
      stopHandler.cleanup();
      await closeUiServer(uiStart?.handle ?? null);
    }

    if (res.stopped) {
      const signalLabel = res.stopped.signal ? ` (${res.stopped.signal})` : "";
      const containerLabel =
        res.stopped.containers === "stopped" ? "stopped" : "left running for resume";
      console.log(
        `Run ${res.runId} stopped by signal${signalLabel}; containers ${containerLabel}.`,
      );
      console.log(`Resume with: mycelium resume --project ${projectName} --run-id ${res.runId}`);
      return;
    }

    if (runOptions.dryRun) {
      printDryRunPlan(res.runId, res.plan);
      return;
    }

    console.log(`Run ${res.runId} finished with status: ${res.state.status}`);
  } catch (error) {
    const normalized = normalizeRunCommandError(error, {
      useDocker: opts.useDocker,
    });
    throw normalized;
  }
}

function printDryRunPlan(runId: string, plan: BatchPlanEntry[]): void {
  if (plan.length === 0) {
    console.log(`Dry run ${runId}: no pending tasks.`);
    return;
  }

  console.log(`Dry run ${runId}: ${plan.length} batch(es) planned.`);
  for (const batch of plan) {
    const lockText = formatLocks(batch.locks);
    const locksSuffix = lockText ? ` [locks: ${lockText}]` : "";
    console.log(`- Batch ${batch.batchId}: ${batch.taskIds.join(", ")}${locksSuffix}`);
  }
}

function formatLocks(locks: BatchPlanEntry["locks"]): string {
  const reads = locks.reads ?? [];
  const writes = locks.writes ?? [];

  const parts = [];
  if (reads.length > 0) parts.push(`reads=${reads.join(",")}`);
  if (writes.length > 0) parts.push(`writes=${writes.join(",")}`);

  return parts.join("; ");
}

// =============================================================================
// ERROR NORMALIZATION
// =============================================================================

const RUN_COMMAND_FAILURE_TITLE = "Run command failed.";
const RUN_COMMAND_DOCKER_HINT =
  "Start the Docker daemon and retry, or run with --local-worker to bypass Docker.";
const RUN_COMMAND_TASK_HINT =
  "Rerun `mycelium plan` to regenerate tasks, or check `tasks_dir` in your repo config.";
const RUN_COMMAND_RUN_STATE_HINT =
  "Run `mycelium resume` to recover the run, or `mycelium clean` to remove the run state.";

type RunCommandErrorContext = {
  useDocker?: boolean;
};

function normalizeRunCommandError(
  error: unknown,
  context: RunCommandErrorContext,
): UserFacingError {
  if (error instanceof UserFacingError) {
    return new UserFacingError({
      code: error.code,
      title: RUN_COMMAND_FAILURE_TITLE,
      message: error.message,
      hint: error.hint ?? resolveRunCommandHint(error, context),
      next: error.next,
      cause: error.cause ?? error,
    });
  }

  return new UserFacingError({
    code: resolveCommandErrorCode(error),
    title: RUN_COMMAND_FAILURE_TITLE,
    message: formatErrorMessage(error),
    hint: resolveRunCommandHint(error, context),
    cause: error,
  });
}

function resolveRunCommandHint(
  error: unknown,
  context: RunCommandErrorContext,
): string | undefined {
  if (context.useDocker !== false && isDockerError(error)) {
    return RUN_COMMAND_DOCKER_HINT;
  }

  if (isTaskError(error)) {
    return RUN_COMMAND_TASK_HINT;
  }

  if (isRunStateError(error)) {
    return RUN_COMMAND_RUN_STATE_HINT;
  }

  return undefined;
}

function resolveCommandErrorCode(error: unknown): UserFacingErrorCode {
  if (error instanceof UserFacingError) {
    return error.code;
  }
  if (error instanceof ConfigError) {
    return USER_FACING_ERROR_CODES.config;
  }
  if (error instanceof TaskError) {
    return USER_FACING_ERROR_CODES.task;
  }
  if (error instanceof DockerError) {
    return USER_FACING_ERROR_CODES.docker;
  }
  if (error instanceof GitError) {
    return USER_FACING_ERROR_CODES.git;
  }

  return USER_FACING_ERROR_CODES.unknown;
}

function isDockerError(error: unknown): boolean {
  const userError = resolveUserFacingError(error);
  if (userError?.code === USER_FACING_ERROR_CODES.docker) {
    return true;
  }

  if (error instanceof DockerError) {
    return true;
  }

  const code = resolveErrorCode(error);
  if (code === "ECONNREFUSED" || code === "ENOENT") {
    return true;
  }

  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("docker");
}

function isTaskError(error: unknown): boolean {
  const userError = resolveUserFacingError(error);
  if (userError?.code === USER_FACING_ERROR_CODES.task) {
    return true;
  }

  if (error instanceof TaskError) {
    return true;
  }

  return false;
}

function isRunStateError(error: unknown): boolean {
  const userError = resolveUserFacingError(error);
  const title = userError?.title ?? "";
  if (title.toLowerCase().includes("run state")) {
    return true;
  }

  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("run state");
}

function resolveUserFacingError(error: unknown): UserFacingError | null {
  if (error instanceof UserFacingError) {
    return error;
  }

  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof UserFacingError) {
      return cause;
    }
  }

  return null;
}

function resolveErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }

  return null;
}
