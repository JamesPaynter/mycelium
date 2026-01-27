/**
 * DockerWorkerRunner executes worker attempts inside a Docker container.
 * Purpose: isolate Docker concerns from the executor.
 * Assumptions: the executor prepares the workspace and state store.
 * Usage: new DockerWorkerRunner(...).runAttempt(...)
 */

import { logOrchestratorEvent, type JsonObject } from "../../../core/logger.js";
import type { ContainerSpec } from "../../../docker/docker.js";
import { buildWorkerImage } from "../../../docker/image.js";
import { DockerManager } from "../../../docker/manager.js";
import type { LogStreamHandle } from "../../../docker/streams.js";

import {
  buildContainerEnv,
  buildContainerLabels,
  buildWorkerContainerName,
  CONTAINER_LOGS_DIR,
  CONTAINER_WORKDIR,
  findTaskContainer,
} from "./docker-worker-helpers.js";
import {
  cleanupTaskContainer,
  stopRunContainers,
} from "./docker-worker-runner-cleanup.js";
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
    const containerInfo = await findTaskContainer(
      this.docker,
      this.projectName,
      this.runId,
      input.taskId,
      input.containerIdHint,
    );
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
    return stopRunContainers({
      docker: this.docker,
      projectName: this.projectName,
      runId: this.runId,
      stopContainersOnExit: input.stopContainersOnExit,
      orchestratorLogger: input.orchestratorLogger,
    });
  }

  async cleanupTask(input: WorkerCleanupInput): Promise<void> {
    await cleanupTaskContainer({
      docker: this.docker,
      projectName: this.projectName,
      runId: this.runId,
      taskId: input.taskId,
      containerIdHint: input.containerIdHint,
      orchestratorLogger: input.orchestratorLogger,
    });
  }
}
