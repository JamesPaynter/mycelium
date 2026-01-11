import { PassThrough } from "node:stream";

import Docker from "dockerode";

import { DockerError } from "../core/errors.js";
import type { JsonlLogger } from "../core/logger.js";

import {
  type ContainerSpec,
  type ContainerWaitResult,
  createContainer as createDockerContainer,
  dockerClient,
  removeContainer as removeDockerContainer,
  startContainer as startDockerContainer,
  waitContainer,
} from "./docker.js";
import { streamContainerLogs } from "./streams.js";

export type RunContainerOptions = {
  spec: ContainerSpec;
  logger?: JsonlLogger;
  cleanupOnSuccess?: boolean;
  logFallbackType?: string;
};

export type RunContainerResult = ContainerWaitResult & {
  containerId: string;
  containerName?: string;
};

export type ExecOptions = {
  env?: Record<string, string | undefined>;
  workdir?: string;
  user?: string;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class DockerManager {
  private readonly docker: Docker;
  private readonly cleanupOnSuccess: boolean;

  constructor(opts: { docker?: Docker; cleanupOnSuccess?: boolean } = {}) {
    this.docker = opts.docker ?? dockerClient();
    this.cleanupOnSuccess = opts.cleanupOnSuccess ?? false;
  }

  async createContainer(spec: ContainerSpec): Promise<Docker.Container> {
    return createDockerContainer(this.docker, spec);
  }

  async startContainer(container: Docker.Container): Promise<void> {
    await startDockerContainer(container);
  }

  async waitForExit(
    container: Docker.Container,
    opts: { cleanupOnSuccess?: boolean } = {},
  ): Promise<ContainerWaitResult> {
    const result = await waitContainer(container);
    const shouldCleanup = opts.cleanupOnSuccess ?? this.cleanupOnSuccess;

    if (shouldCleanup && result.exitCode === 0) {
      await removeDockerContainer(container);
    }

    return result;
  }

  async streamLogsToLogger(
    container: Docker.Container,
    logger: JsonlLogger,
    fallbackType?: string,
  ): Promise<() => void> {
    return streamContainerLogs(container, logger, { fallbackType });
  }

  async runContainer(opts: RunContainerOptions): Promise<RunContainerResult> {
    const container = await this.createContainer(opts.spec);
    const info = await container.inspect();

    let detachLogs: (() => void) | undefined;
    try {
      if (opts.logger) {
        detachLogs = await this.streamLogsToLogger(container, opts.logger, opts.logFallbackType);
      }

      await this.startContainer(container);
      const waited = await this.waitForExit(container, {
        cleanupOnSuccess: opts.cleanupOnSuccess,
      });

      return {
        ...waited,
        containerId: info.Id ?? opts.spec.name,
        containerName: info.Name,
      };
    } finally {
      if (detachLogs) {
        try {
          detachLogs();
        } catch {
          // ignore
        }
      }
    }
  }

  async execInContainer(
    container: Docker.Container,
    command: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    try {
      const exec = await container.exec({
        Cmd: command,
        Env: normalizeEnv(opts.env),
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: opts.workdir,
        User: opts.user,
        Tty: false,
      });

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      const stream = await exec.start({ hijack: true, stdin: false });
      pipeExecStream(stream, stdout, stderr, container);

      const [stdoutText, stderrText] = await Promise.all([
        collectStream(stdout),
        collectStream(stderr),
      ]);

      const inspect = await exec.inspect();
      const exitCode = inspect?.ExitCode ?? -1;

      return { exitCode, stdout: stdoutText, stderr: stderrText };
    } catch (err: any) {
      throw new DockerError(
        `Failed to exec in container: ${err?.message ?? String(err)}`,
        err,
      );
    }
  }

  async removeContainer(container: Docker.Container): Promise<void> {
    await removeDockerContainer(container);
  }
}

function normalizeEnv(env?: Record<string, string | undefined>): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
}

function pipeExecStream(
  stream: NodeJS.ReadableStream,
  stdout: PassThrough,
  stderr: PassThrough,
  container: Docker.Container,
): void {
  const modem =
    (container as any).modem ??
    (stream as any).modem ??
    (container as any).docker?.modem ??
    (container as any).client?.modem;

  if (modem && typeof modem.demuxStream === "function") {
    modem.demuxStream(stream, stdout, stderr);
  } else {
    stream.pipe(stdout);
  }

  const close = (): void => {
    stdout.end();
    stderr.end();
  };

  stream.on("end", close);
  stream.on("close", close);
  stream.on("error", (err) => {
    stdout.destroy(err);
    stderr.destroy(err);
  });
}

function collectStream(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}
