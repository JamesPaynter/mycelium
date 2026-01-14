import type { ProjectConfig } from "../core/config.js";
import { runProject, type RunOptions } from "../core/executor.js";
import { loadRunStateForProject } from "../core/state-store.js";

type ResumeOptions = Pick<RunOptions, "maxParallel" | "dryRun" | "buildImage" | "useDocker"> & {
  runId?: string;
};

export async function resumeCommand(
  projectName: string,
  config: ProjectConfig,
  opts: ResumeOptions,
): Promise<void> {
  const resolved = await loadRunStateForProject(projectName, opts.runId);
  if (!resolved) {
    const notFound = opts.runId
      ? `Run ${opts.runId} not found for project ${projectName}.`
      : `No runs found for project ${projectName}.`;
    console.log(notFound);
    return;
  }

  const res = await runProject(projectName, config, {
    runId: resolved.runId,
    maxParallel: opts.maxParallel,
    dryRun: opts.dryRun,
    buildImage: opts.buildImage,
    useDocker: opts.useDocker,
    resume: true,
  });

  console.log(`Run ${res.runId} resumed with status: ${res.state.status}`);
}
