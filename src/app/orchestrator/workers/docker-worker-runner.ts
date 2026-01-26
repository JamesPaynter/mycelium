/**
 * DockerWorkerRunner executes worker attempts inside a Docker container.
 * Purpose: isolate Docker concerns from the executor.
 * Assumptions: the executor prepares the workspace and state store.
 * Usage: new DockerWorkerRunner(...).runAttempt(...)
 */

import path from "node:path";

import { logOrchestratorEvent, type JsonObject } from "../../../core/logger.js";
import type { ContainerSpec } from "../../../docker/docker.js";
import { buildWorkerImage } from "../../../docker/image.js";
import { DockerManager, type ListedContainer } from "../../../docker/manager.js";
import type { LogStreamHandle } from "../../../docker/streams.js";
import { formatErrorMessage } from "../helpers/errors.js";

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
// TYPES & CONSTANTS
// =============================================================================

export type DockerWorkerRunnerOptions = {
  projectName: string;
  runId: string;
  workerImage: string;
  dockerfile: string;
  buildContext: string;
  tasksDirPosix: string;
  containerResources?: ContainerSpec["resources"];
  containerSecurityPayload: JsonObject;
  networkMode?: ContainerSpec["networkMode"];
  containerUser?: string;
  dockerManager?: DockerManager;
};

const LABEL_PREFIX = "mycelium";
const CONTAINER_NAME_LIMIT = 120;
const CONTAINER_WORKDIR = "/workspace";
const CONTAINER_LOGS_DIR = "/run-logs";
const CONTAINER_CODEX_HOME = "/workspace/.mycelium/codex-home";


// =============================================================================
// RUNNER
// =============================================================================

export class DockerWorkerRunner implements WorkerRunner {
  private readonly docker: DockerManager;
  private readonly projectName: string;
  private readonly runId: string;
  private readonly workerImage: string;
  private readonly dockerfile: string;
  private readonly buildContext: string;
  private readonly tasksDirPosix: string;
  private readonly containerResources?: ContainerSpec["resources"];
  private readonly containerSecurityPayload: JsonObject;
  private readonly networkMode?: ContainerSpec["networkMode"];
  private readonly containerUser?: string;

  constructor(opts: DockerWorkerRunnerOptions) {
    this.docker = opts.dockerManager ?? new DockerManager();
    this.projectName = opts.projectName;
    this.runId = opts.runId;
    this.workerImage = opts.workerImage;
    this.dockerfile = opts.dockerfile;
    this.buildContext = opts.buildContext;
    this.tasksDirPosix = opts.tasksDirPosix;
    this.containerResources = opts.containerResources;
    this.containerSecurityPayload = opts.containerSecurityPayload;
    this.networkMode = opts.networkMode;
    this.containerUser = opts.containerUser;
  }

  async prepare(input: WorkerPrepareInput): Promise<void> {
    if (input.buildImage) {
      logOrchestratorEvent(input.orchestratorLogger, "docker.image.build.start", {
        image: this.workerImage,
      });
      await buildWorkerImage({
        tag: this.workerImage,
        dockerfile: this.dockerfile,
        context: this.buildContext,
      });
      logOrchestratorEvent(input.orchestratorLogger, "docker.image.build.complete", {
        image: this.workerImage,
      });
      return;
    }

    const haveImage = await this.docker.imageExists(this.workerImage);
    if (!haveImage) {
      throw new Error(
        `Docker image not found: ${this.workerImage}. Build it or run with --build-image.`,
      );
    }
  }

  async runAttempt(input: WorkerRunAttemptInput): Promise<WorkerRunnerResult> {
    const containerName = buildWorkerContainerName({
      projectName: this.projectName,
      runId: this.runId,
      taskId: input.taskId,
      taskSlug: input.taskSlug,
    });
    const existing = await this.docker.findContainerByName(containerName);
    if (existing) {
      await this.docker.removeContainer(existing);
    }

    const container = await this.docker.createContainer({
      name: containerName,
      image: this.workerImage,
      user: this.containerUser,
      env: buildContainerEnv({
        input,
        tasksDirPosix: this.tasksDirPosix,
      }),
      binds: [
        { hostPath: input.workspace, containerPath: CONTAINER_WORKDIR, mode: "rw" },
        { hostPath: input.runLogsDir, containerPath: CONTAINER_LOGS_DIR, mode: "rw" },
      ],
      workdir: CONTAINER_WORKDIR,
      networkMode: this.networkMode,
      resources: this.containerResources,
      labels: buildContainerLabels({
        projectName: this.projectName,
        runId: this.runId,
        taskId: input.taskId,
        branchName: input.taskBranch,
        workspace: input.workspace,
      }),
    });

    const containerInfo = await this.docker.inspectContainer(container);
    const containerId = containerInfo.Id ?? containerName;
    if (input.onContainerReady) {
      await input.onContainerReady(containerId);
    }

    logOrchestratorEvent(input.orchestratorLogger, "container.create", {
      taskId: input.taskId,
      container_id: containerId,
      name: containerName,
      security: this.containerSecurityPayload,
    });

    let logStream: LogStreamHandle | undefined;
    try {
      logStream = await this.docker.streamLogsToLogger(container, input.taskEvents, {
        fallbackType: "task.log",
      });

      await this.docker.startContainer(container);
      logOrchestratorEvent(input.orchestratorLogger, "container.start", {
        taskId: input.taskId,
        container_id: containerId,
      });

      if (input.crashAfterStart) {
        process.kill(process.pid, "SIGKILL");
      }

      const waited = await this.docker.waitForExit(container);

      logOrchestratorEvent(input.orchestratorLogger, "container.exit", {
        taskId: input.taskId,
        container_id: containerId,
        exit_code: waited.exitCode,
      });

      if (waited.exitCode === 0) {
        return { success: true, containerId };
      }

      return {
        success: false,
        containerId,
        errorMessage: `Task worker container exited with code ${waited.exitCode}`,
      };
    } finally {
      if (logStream) {
        logStream.detach();
        await logStream.completed.catch(() => undefined);
      }
    }
  }

  async resumeAttempt(input: WorkerResumeAttemptInput): Promise<WorkerRunnerResult> {
    const containerInfo = await this.findTaskContainer(input.taskId, input.containerIdHint);
    if (!containerInfo) {
      const payload: Record<string, string> = { taskId: input.taskId };
      if (input.containerIdHint) {
        payload.container_id = input.containerIdHint;
      }
      logOrchestratorEvent(input.orchestratorLogger, "container.missing", payload);
      return {
        success: false,
        errorMessage: "Task container missing on resume",
        resetToPending: true,
      };
    }

    let logStream: LogStreamHandle | undefined;
    try {
      const container = this.docker.getContainer(containerInfo.id);
      const inspect = await this.docker.inspectContainer(container);
      const isRunning = inspect.State?.Running ?? false;
      const containerId = inspect.Id ?? containerInfo.id;

      logStream = await this.docker.streamLogsToLogger(container, input.taskEvents, {
        fallbackType: "task.log",
        includeHistory: true,
        follow: true,
      });

      logOrchestratorEvent(input.orchestratorLogger, "container.reattach", {
        taskId: input.taskId,
        container_id: containerId,
        ...(containerInfo.name ? { name: containerInfo.name } : {}),
        running: isRunning,
      });

      const waited = await this.docker.waitForExit(container);

      logOrchestratorEvent(
        input.orchestratorLogger,
        isRunning ? "container.exit" : "container.exited-on-resume",
        {
          taskId: input.taskId,
          container_id: containerId,
          exit_code: waited.exitCode,
        },
      );

      if (waited.exitCode === 0) {
        return { success: true, containerId };
      }

      return {
        success: false,
        containerId,
        errorMessage: `Task worker container exited with code ${waited.exitCode}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, errorMessage: message, resetToPending: true };
    } finally {
      if (logStream) {
        logStream.detach();
        await logStream.completed.catch(() => undefined);
      }
    }
  }

  async stop(input: WorkerStopInput): Promise<WorkerStopResult | null> {
    if (!input.stopContainersOnExit) {
      return null;
    }

    const containers = await this.listRunContainers();
    let stopped = 0;
    let errors = 0;

    for (const c of containers) {
      const containerName = firstContainerName(c.names);
      const taskId = containerLabel(c.labels, "task_id");

      try {
        const container = this.docker.getContainer(c.id);
        await this.docker.stopContainer(container);
        await this.docker.removeContainer(container);
        stopped += 1;
        const payload: JsonObject & { taskId?: string } = {
          container_id: c.id,
          ...(containerName ? { name: containerName } : {}),
        };
        if (taskId) payload.taskId = taskId;
        logOrchestratorEvent(input.orchestratorLogger, "container.stop", payload);
      } catch (err) {
        errors += 1;
        const payload: JsonObject & { taskId?: string } = {
          container_id: c.id,
          ...(containerName ? { name: containerName } : {}),
          message: formatErrorMessage(err),
        };
        if (taskId) payload.taskId = taskId;
        logOrchestratorEvent(input.orchestratorLogger, "container.stop_failed", payload);
      }
    }

    return { stopped, errors };
  }

  async cleanupTask(input: WorkerCleanupInput): Promise<void> {
    const containerInfo = await this.findTaskContainer(input.taskId, input.containerIdHint);
    if (!containerInfo) return;

    const container = this.docker.getContainer(containerInfo.id);
    await this.docker.removeContainer(container);
    logOrchestratorEvent(input.orchestratorLogger, "container.cleanup", {
      taskId: input.taskId,
      container_id: containerInfo.id,
      ...(containerInfo.name ? { name: containerInfo.name } : {}),
    });
  }

  private async listRunContainers(): Promise<ListedContainer[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.filter(
      (container) =>
        containerLabel(container.labels, "project") === this.projectName &&
        containerLabel(container.labels, "run_id") === this.runId,
    );
  }

  private async findTaskContainer(
    taskId: string,
    containerIdHint?: string,
  ): Promise<{ id: string; name?: string } | null> {
    const containers = await this.listRunContainers();

    const byTask = containers.find(
      (container) => containerLabel(container.labels, "task_id") === taskId,
    );
    if (byTask) {
      return { id: byTask.id, name: firstContainerName(byTask.names) };
    }

    if (containerIdHint) {
      const byId = containers.find(
        (container) =>
          container.id === containerIdHint || container.id.startsWith(containerIdHint),
      );
      if (byId) {
        return { id: byId.id, name: firstContainerName(byId.names) };
      }

      try {
        const inspected = await this.docker.inspectContainer(
          this.docker.getContainer(containerIdHint),
        );
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
}


// =============================================================================
// HELPERS
// =============================================================================

export function buildWorkerContainerName(values: {
  projectName: string;
  runId: string;
  taskId: string;
  taskSlug: string;
}): string {
  const raw = `to-${values.projectName}-${values.runId}-${values.taskId}-${values.taskSlug}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, CONTAINER_NAME_LIMIT);
}

function labelKey(key: string): string {
  return `${LABEL_PREFIX}.${key}`;
}

function containerLabel(
  labels: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!labels) return undefined;
  return labels[labelKey(key)];
}

function buildContainerLabels(values: {
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

function buildContainerEnv(args: {
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
    LINT_TIMEOUT: args.input.lintTimeoutSeconds
      ? String(args.input.lintTimeoutSeconds)
      : undefined,
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

function firstContainerName(names?: string[]): string | undefined {
  if (!names || names.length === 0) return undefined;
  const raw = names[0] ?? "";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}
