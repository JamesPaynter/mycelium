import fs from "node:fs/promises";
import path from "node:path";

import { DockerError } from "../core/errors.js";
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
  } catch {
    throw new DockerError(
      `Dockerfile not found at ${resolved}. Update your project config or provide a custom path.`,
    );
  }

  return resolved;
}
