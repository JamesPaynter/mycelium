import fs from "node:fs";

import type { ProjectConfig } from "../core/config.js";
import { runProject, type RunOptions } from "../core/executor.js";
import { runStateDir } from "../core/paths.js";

type ResumeOptions = Pick<RunOptions, "maxParallel" | "dryRun" | "buildImage"> & {
  runId?: string;
};

export async function resumeCommand(
  projectName: string,
  config: ProjectConfig,
  opts: ResumeOptions,
): Promise<void> {
  const runId = opts.runId ?? findLatestRunId(projectName);
  if (!runId) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  const res = await runProject(projectName, config, {
    runId,
    maxParallel: opts.maxParallel,
    dryRun: opts.dryRun,
    buildImage: opts.buildImage,
  });

  console.log(`Run ${res.runId} resumed with status: ${res.state.status}`);
}

function findLatestRunId(projectName: string): string | null {
  const dir = runStateDir(projectName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  const latest = files[files.length - 1];
  return latest.replace(/^run-/, "").replace(/\.json$/, "");
}
