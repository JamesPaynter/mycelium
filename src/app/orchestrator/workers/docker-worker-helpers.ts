import path from "node:path";

import type { DockerManager, ListedContainer } from "../../../docker/manager.js";

import type { WorkerRunAttemptInput } from "./worker-runner.js";

const LABEL_PREFIX = "mycelium";
const CONTAINER_NAME_LIMIT = 120;

export const CONTAINER_WORKDIR = "/workspace";
export const CONTAINER_LOGS_DIR = "/run-logs";
export const CONTAINER_CODEX_HOME = "/workspace/.mycelium/codex-home";

export function buildWorkerContainerName(values: {
  projectName: string;
  runId: string;
  taskId: string;
  taskSlug: string;
}): string {
  const raw = `to-${values.projectName}-${values.runId}-${values.taskId}-${values.taskSlug}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, CONTAINER_NAME_LIMIT);
}

export function buildContainerLabels(values: {
  projectName: string;
  runId: string;
  taskId: string;
  branchName: string;
  workspace: string;
}): Record<string, string> {
  return {
    [labelKey("project")]: values.projectName,
    [labelKey("run_id")]: values.runId,
    [labelKey("task_id")]: values.taskId,
    [labelKey("branch")]: values.branchName,
    [labelKey("workspace_path")]: values.workspace,
  };
}

export function buildContainerEnv(args: {
  input: WorkerRunAttemptInput;
  tasksDirPosix: string;
}): Record<string, string | undefined> {
  const manifestPath = path.posix.join(
    CONTAINER_WORKDIR,
    args.tasksDirPosix,
    args.input.taskPaths.taskRelativeDirPosix,
    "manifest.json",
  );
  const specPath = path.posix.join(
    CONTAINER_WORKDIR,
    args.tasksDirPosix,
    args.input.taskPaths.taskRelativeDirPosix,
    "spec.md",
  );

  return {
    CODEX_API_KEY: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION,
    TASK_ID: args.input.taskId,
    TASK_SLUG: args.input.taskSlug,
    TASK_MANIFEST_PATH: manifestPath,
    TASK_SPEC_PATH: specPath,
    TASK_BRANCH: args.input.taskBranch,
    LINT_CMD: args.input.lintCommand,
    LINT_TIMEOUT: args.input.lintTimeoutSeconds ? String(args.input.lintTimeoutSeconds) : undefined,
    DOCTOR_CMD: args.input.doctorCommand,
    DOCTOR_TIMEOUT: args.input.doctorTimeoutSeconds
      ? String(args.input.doctorTimeoutSeconds)
      : undefined,
    MAX_RETRIES: String(args.input.maxRetries),
    CHECKPOINT_COMMITS: args.input.checkpointCommits ? "true" : "false",
    DEFAULT_TEST_PATHS: JSON.stringify(args.input.defaultTestPaths ?? []),
    BOOTSTRAP_CMDS:
      args.input.bootstrapCmds.length > 0 ? JSON.stringify(args.input.bootstrapCmds) : undefined,
    CODEX_MODEL: args.input.codexModel,
    CODEX_MODEL_REASONING_EFFORT: args.input.codexModelReasoningEffort,
    CODEX_HOME: CONTAINER_CODEX_HOME,
    RUN_LOGS_DIR: CONTAINER_LOGS_DIR,
    LOG_CODEX_PROMPTS: args.input.logCodexPrompts ? "1" : "0",
  };
}

export async function listRunContainers(
  docker: DockerManager,
  projectName: string,
  runId: string,
): Promise<ListedContainer[]> {
  const containers = await docker.listContainers({ all: true });
  return containers.filter(
    (container) =>
      containerLabel(container.labels, "project") === projectName &&
      containerLabel(container.labels, "run_id") === runId,
  );
}

export async function findTaskContainer(
  docker: DockerManager,
  projectName: string,
  runId: string,
  taskId: string,
  containerIdHint?: string,
): Promise<{ id: string; name?: string } | null> {
  const containers = await listRunContainers(docker, projectName, runId);

  const byTask = containers.find(
    (container) => containerLabel(container.labels, "task_id") === taskId,
  );
  if (byTask) {
    return { id: byTask.id, name: firstContainerName(byTask.names) };
  }

  if (containerIdHint) {
    const byId = containers.find(
      (container) => container.id === containerIdHint || container.id.startsWith(containerIdHint),
    );
    if (byId) {
      return { id: byId.id, name: firstContainerName(byId.names) };
    }

    try {
      const inspected = await docker.inspectContainer(docker.getContainer(containerIdHint));
      return {
        id: inspected.Id ?? containerIdHint,
        name: firstContainerName([inspected.Name]),
      };
    } catch {
      // ignore
    }
  }

  return null;
}

export function containerLabel(
  labels: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!labels) return undefined;
  return labels[labelKey(key)];
}

export function firstContainerName(names?: string[]): string | undefined {
  if (!names || names.length === 0) return undefined;
  const raw = names[0] ?? "";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

function labelKey(key: string): string {
  return `${LABEL_PREFIX}.${key}`;
}
