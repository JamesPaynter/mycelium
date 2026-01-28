import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import { buildCleanupPlan, executeCleanupPlan, type CleanupPlan } from "../core/cleanup.js";
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
import { DockerManager } from "../docker/manager.js";

type CleanOptions = {
  runId?: string;
  keepLogs?: boolean;
  force?: boolean;
  dryRun?: boolean;
  removeContainers?: boolean;
};

export async function cleanCommand(
  projectName: string,
  config: ProjectConfig,
  opts: CleanOptions,
  appContext?: AppContext,
): Promise<void> {
  const removeContainers = opts.removeContainers !== false;
  const dockerManager = removeContainers ? new DockerManager() : undefined;
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });

  try {
    const plan = await resolveCleanupPlan(
      projectName,
      opts,
      removeContainers,
      dockerManager,
      paths,
    );
    if (!plan) return;
    if (isPlanEmpty(plan)) {
      logEmptyPlan(plan, removeContainers);
      return;
    }

    printPlan(plan, { keepLogs: opts.keepLogs ?? false, includeContainers: removeContainers });

    if (opts.dryRun) {
      console.log("Dry run only. No files or containers were removed.");
      return;
    }

    const confirmed = await confirmCleanupOrAbort(plan.runId, opts);
    if (!confirmed) return;

    await executeCleanupPlanOrReport(plan, dockerManager);
    console.log("Cleanup complete.");
  } catch (error) {
    throw normalizeCleanCommandError(error, { removeContainers });
  }
}

async function resolveCleanupPlan(
  projectName: string,
  opts: CleanOptions,
  removeContainers: boolean,
  dockerManager: DockerManager | undefined,
  paths: AppContext["paths"],
): Promise<CleanupPlan | null> {
  const plan = await buildCleanupPlan(projectName, {
    runId: opts.runId,
    keepLogs: opts.keepLogs,
    removeContainers,
    dockerManager,
    paths,
  });
  if (!plan) {
    console.log(`No runs found for project ${projectName}.`);
  }
  return plan;
}

function isPlanEmpty(plan: CleanupPlan): boolean {
  return plan.targets.length === 0 && plan.containers.length === 0;
}

function logEmptyPlan(plan: CleanupPlan, removeContainers: boolean): void {
  const suffix = removeContainers ? "" : " Containers were not checked (--no-containers).";
  console.log(`Nothing to clean for run ${plan.runId}.${suffix}`);
}

async function confirmCleanupOrAbort(runId: string, opts: CleanOptions): Promise<boolean> {
  if (opts.force ?? false) {
    return true;
  }
  const confirmed = await confirmCleanup(runId);
  if (!confirmed) {
    console.log("Cleanup cancelled.");
  }
  return confirmed;
}

async function executeCleanupPlanOrReport(
  plan: CleanupPlan,
  dockerManager: DockerManager | undefined,
): Promise<void> {
  await executeCleanupPlan(plan, {
    dryRun: false,
    log: (msg) => console.log(msg),
    dockerManager,
  });
}

function printPlan(
  plan: CleanupPlan,
  opts: { keepLogs: boolean; includeContainers: boolean },
): void {
  console.log(`Cleaning run ${plan.runId} for project ${plan.projectName}:`);

  for (const target of plan.targets) {
    console.log(`- ${target.kind}: ${target.path}`);
  }

  if (plan.containers.length > 0) {
    for (const container of plan.containers) {
      const label = container.name ?? container.id;
      const state = container.state ?? container.status ?? "unknown";
      console.log(`- container: ${label} [state=${state}]`);
    }
  } else if (opts.includeContainers) {
    console.log("- no containers found for this run");
  }

  if (opts.keepLogs && !plan.targets.some((t) => t.kind === "logs")) {
    console.log("- logs retained (--keep-logs)");
  }

  if (!opts.includeContainers) {
    console.log("- containers retained (--no-containers)");
  }
}

async function confirmCleanup(runId: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    console.log("Non-interactive session detected. Re-run with --force to skip confirmation.");
    return false;
  }

  const rl = createInterface({ input, output });
  const answer = await rl.question(`Proceed with deleting artifacts for run ${runId}? (y/N) `);
  rl.close();

  return /^y(es)?$/i.test(answer.trim());
}

// =============================================================================
// ERROR NORMALIZATION
// =============================================================================

const CLEAN_COMMAND_FAILURE_TITLE = "Clean command failed.";
const CLEAN_COMMAND_DOCKER_HINT = "Rerun with --no-containers if Docker is unavailable.";
const CLEAN_COMMAND_PERMISSIONS_HINT = "Check file permissions for run artifacts and try again.";

type CleanCommandErrorContext = {
  removeContainers: boolean;
};

function normalizeCleanCommandError(
  error: unknown,
  context: CleanCommandErrorContext,
): UserFacingError {
  if (error instanceof UserFacingError) {
    return new UserFacingError({
      code: error.code,
      title: CLEAN_COMMAND_FAILURE_TITLE,
      message: error.message,
      hint: error.hint ?? resolveCleanCommandHint(error, context),
      next: error.next,
      cause: error.cause ?? error,
    });
  }

  return new UserFacingError({
    code: resolveCommandErrorCode(error),
    title: CLEAN_COMMAND_FAILURE_TITLE,
    message: formatErrorMessage(error),
    hint: resolveCleanCommandHint(error, context),
    cause: error,
  });
}

function resolveCleanCommandHint(
  error: unknown,
  context: CleanCommandErrorContext,
): string | undefined {
  if (context.removeContainers && isDockerError(error)) {
    return CLEAN_COMMAND_DOCKER_HINT;
  }

  const code = resolveErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return CLEAN_COMMAND_PERMISSIONS_HINT;
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
