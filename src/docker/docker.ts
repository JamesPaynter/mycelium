import path from "node:path";

import Docker from "dockerode";

import { DockerError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

export const DEFAULT_CPU_PERIOD = 100_000;

export type ContainerSpec = {
  name: string;
  image: string;
  env: Record<string, string | undefined>;
  binds: Array<{ hostPath: string; containerPath: string; mode: "rw" | "ro" }>;
  workdir: string;
  labels?: Record<string, string>;
  // Optional: override command
  cmd?: string[];
  user?: string;
  networkMode?: "bridge" | "none";
  resources?: {
    memoryBytes?: number;
    cpuQuota?: number;
    cpuPeriod?: number;
    pidsLimit?: number;
  };
};

export type ContainerWaitResult = { exitCode: number; status: string };

export function dockerClient(): Docker {
  return new Docker();
}

export async function imageExists(docker: Docker, imageName: string): Promise<boolean> {
  try {
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function createContainer(
  docker: Docker,
  spec: ContainerSpec,
): Promise<Docker.Container> {
  try {
    const Env = Object.entries(spec.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);

    const Binds = spec.binds.map((b) => `${path.resolve(b.hostPath)}:${b.containerPath}:${b.mode}`);

    const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
      Binds,
      NetworkMode: spec.networkMode ?? "bridge",
      AutoRemove: false,
    };

    if (spec.resources?.memoryBytes !== undefined) {
      hostConfig.Memory = spec.resources.memoryBytes;
    }
    if (spec.resources?.cpuQuota !== undefined) {
      hostConfig.CpuQuota = spec.resources.cpuQuota;
      hostConfig.CpuPeriod = spec.resources.cpuPeriod ?? DEFAULT_CPU_PERIOD;
    }
    if (spec.resources?.pidsLimit !== undefined) {
      hostConfig.PidsLimit = spec.resources.pidsLimit;
    }

    const container = await docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Env,
      WorkingDir: spec.workdir,
      Cmd: spec.cmd,
      Labels: spec.labels,
      User: spec.user,
      HostConfig: hostConfig,
    });

    return container;
  } catch (err) {
    throw createContainerUserFacingError(spec.name, err);
  }
}

export async function startContainer(container: Docker.Container): Promise<void> {
  try {
    await container.start();
  } catch (err) {
    throw createStartContainerUserFacingError(err);
  }
}

export async function waitContainer(container: Docker.Container): Promise<ContainerWaitResult> {
  const res = await container.wait();
  // dockerode returns { StatusCode: number }
  const exitCode = (res as any).StatusCode ?? -1;
  return { exitCode, status: exitCode === 0 ? "exited:0" : `exited:${exitCode}` };
}

export async function removeContainer(container: Docker.Container): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    // ignore
  }
}

export async function findContainerByName(
  docker: Docker,
  name: string,
): Promise<Docker.Container | null> {
  const containers = await docker.listContainers({ all: true });
  const match = containers.find((c) => (c.Names ?? []).includes(`/${name}`));
  if (!match) return null;
  return docker.getContainer(match.Id);
}

// =============================================================================
// ERROR HELPERS
// =============================================================================

const DOCKER_UNAVAILABLE_HINT =
  "Start the Docker daemon and retry, or run with --local-worker to bypass Docker.";

const DOCKER_RUN_HINT = "Check that the container image and configuration are valid, then retry.";

type DockerRunErrorDetails = {
  message: string;
  code?: string;
  reason?: string;
};

function createContainerUserFacingError(name: string, err: unknown): UserFacingError {
  const details = resolveDockerRunErrorDetails(err);
  const detail = details.reason || details.message || "Unknown docker error.";
  const dockerError = new DockerError(`Failed to create container ${name}: ${detail}`, err);

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.docker,
    title: "Docker container creation failed.",
    message: `Unable to create Docker container ${name}.`,
    hint: isDockerUnavailableError(details) ? DOCKER_UNAVAILABLE_HINT : DOCKER_RUN_HINT,
    cause: dockerError,
  });
}

function createStartContainerUserFacingError(err: unknown): UserFacingError {
  const details = resolveDockerRunErrorDetails(err);
  const detail = details.reason || details.message || "Unknown docker error.";
  const dockerError = new DockerError(`Failed to start container: ${detail}`, err);

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.docker,
    title: "Docker container start failed.",
    message: "Unable to start the Docker container.",
    hint: isDockerUnavailableError(details) ? DOCKER_UNAVAILABLE_HINT : DOCKER_RUN_HINT,
    cause: dockerError,
  });
}

function resolveDockerRunErrorDetails(err: unknown): DockerRunErrorDetails {
  if (!err || typeof err !== "object") {
    return { message: String(err) };
  }

  const record = err as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : String(err);
  const code = typeof record.code === "string" ? record.code : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;

  return { message, code, reason };
}

function isDockerUnavailableError(details: DockerRunErrorDetails): boolean {
  if (details.code === "ENOENT" || details.code === "ECONNREFUSED") {
    return true;
  }

  const text = `${details.message}\n${details.reason ?? ""}`.toLowerCase();
  return (
    text.includes("cannot connect to the docker daemon") ||
    text.includes("is the docker daemon running") ||
    text.includes("error during connect") ||
    text.includes("docker.sock") ||
    text.includes("connect econnrefused") ||
    text.includes("connect enoent")
  );
}
