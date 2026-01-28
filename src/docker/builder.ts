import fs from "node:fs/promises";
import path from "node:path";

import { DockerError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

import { buildWorkerImage } from "./image.js";

// =============================================================================
// WORKER IMAGE BUILDER
// =============================================================================

export type WorkerImageBuildOptions = {
  tag: string;
  dockerfile: string;
  context: string;
};

export async function buildWorkerImageFromTemplate(opts: WorkerImageBuildOptions): Promise<void> {
  const dockerfilePath = await ensureDockerfile(opts.dockerfile);

  await buildWorkerImage({
    tag: opts.tag,
    dockerfile: dockerfilePath,
    context: opts.context,
  });
}

async function ensureDockerfile(dockerfile: string): Promise<string> {
  const resolved = path.resolve(dockerfile);

  try {
    await fs.access(resolved);
  } catch (err) {
    throw createMissingDockerfileError(resolved, err);
  }

  return resolved;
}

// =============================================================================
// ERROR HELPERS
// =============================================================================

function createMissingDockerfileError(pathValue: string, err: unknown): UserFacingError {
  const dockerError = new DockerError(`Dockerfile not found at ${pathValue}.`, err);

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.docker,
    title: "Dockerfile not found.",
    message: `Dockerfile not found at ${pathValue}.`,
    hint: "Update docker.dockerfile in your config or provide a custom path.",
    cause: dockerError,
  });
}
