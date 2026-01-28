import { execa } from "execa";

import { DockerError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

export async function buildWorkerImage(opts: {
  tag: string;
  dockerfile: string;
  context: string;
}): Promise<void> {
  try {
    const buildProcess = execa(
      "docker",
      ["build", "-f", opts.dockerfile, "-t", opts.tag, opts.context],
      {
        stdout: "inherit",
        stderr: "pipe",
      },
    );

    buildProcess.stderr?.pipe(process.stderr);
    await buildProcess;
  } catch (err) {
    throw createDockerBuildError(opts.tag, err);
  }
}

// =============================================================================
// ERROR HELPERS
// =============================================================================

const DOCKER_UNAVAILABLE_HINT =
  "Start the Docker daemon and retry, or run with --local-worker to bypass Docker.";

const DOCKER_BUILD_HINT = "Review the Docker build output above for details.";

type DockerBuildErrorDetails = {
  message: string;
  stderr: string;
  code?: string;
};

function createDockerBuildError(tag: string, err: unknown): UserFacingError {
  const details = resolveExecaErrorDetails(err);
  const detail = details.stderr || details.message || "Unknown docker build error.";
  const dockerError = new DockerError(`docker build failed: ${detail}`, err);

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.docker,
    title: "Docker build failed.",
    message: `Unable to build the Docker worker image "${tag}".`,
    hint: isDockerUnavailableError(details) ? DOCKER_UNAVAILABLE_HINT : DOCKER_BUILD_HINT,
    cause: dockerError,
  });
}

function resolveExecaErrorDetails(err: unknown): DockerBuildErrorDetails {
  if (!err || typeof err !== "object") {
    return { message: String(err), stderr: "" };
  }

  const record = err as Record<string, unknown>;
  const stderrRaw = record.stderr;
  const stderr = typeof stderrRaw === "string" ? stderrRaw : stderrRaw ? String(stderrRaw) : "";
  const message = typeof record.message === "string" ? record.message : String(err);
  const code = typeof record.code === "string" ? record.code : undefined;

  return { message, stderr, code };
}

function isDockerUnavailableError(details: DockerBuildErrorDetails): boolean {
  if (details.code === "ENOENT" || details.code === "ECONNREFUSED") {
    return true;
  }

  const text = `${details.message}\n${details.stderr}`.toLowerCase();
  return (
    text.includes("cannot connect to the docker daemon") ||
    text.includes("is the docker daemon running") ||
    text.includes("error during connect") ||
    text.includes("docker.sock") ||
    text.includes("connect econnrefused") ||
    text.includes("connect enoent")
  );
}
