import path from "node:path";

import type { ProjectConfig } from "../core/config.js";
import { JsonlLogger } from "../core/logger.js";
import { plannerLogPath } from "../core/paths.js";
import { planFromImplementationPlan } from "../core/planner.js";
import { defaultRunId } from "../core/utils.js";

export async function planProject(
  projectName: string,
  config: ProjectConfig,
  opts: {
    input: string;
    output?: string;
    dryRun?: boolean;
  },
): Promise<void> {
  const runId = defaultRunId();
  const logRunId = `plan-${runId}`;
  const log = new JsonlLogger(plannerLogPath(projectName, logRunId), { runId: logRunId });

  const outputDir = opts.output
    ? path.isAbsolute(opts.output)
      ? opts.output
      : path.join(config.repo_path, opts.output)
    : path.join(config.repo_path, config.tasks_dir);

  const res = await planFromImplementationPlan({
    projectName,
    config,
    inputPath: opts.input,
    outputDir,
    dryRun: opts.dryRun,
    log,
  });

  if (opts.dryRun) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`Wrote ${res.tasks.length} tasks to ${outputDir}`);
  }

  log.log({ type: "plan.cli.complete", payload: { tasks: res.tasks.length } });
  log.close();
}
