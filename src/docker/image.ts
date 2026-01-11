import { execa } from "execa";
import { DockerError } from "../core/errors.js";

export async function buildWorkerImage(opts: {
  tag: string;
  dockerfile: string;
  context: string;
}): Promise<void> {
  try {
    await execa("docker", [
      "build",
      "-f",
      opts.dockerfile,
      "-t",
      opts.tag,
      opts.context
    ], { stdio: "inherit" });
  } catch (err: any) {
    throw new DockerError(`docker build failed: ${err?.message ?? String(err)}`);
  }
}
