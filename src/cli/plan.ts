import path from "node:path";

import type { ProjectConfig } from "../core/config.js";
import { planFromImplementationPlan } from "../core/planner.js";
import { runLogsDir } from "../core/paths.js";
import { JsonlLogger, eventWithTs } from "../core/logger.js";
import { defaultRunId } from "../core/utils.js";

export async function planProject(
  projectName: string,
  config: ProjectConfig,
  opts: {
    input: string;
    output?: string;
    dryRun?: boolean;
  }
): Promise<void> {
  const runId = defaultRunId();
  const logsDir = runLogsDir(projectName, `plan-${runId}`);
  const log = new JsonlLogger(path.join(logsDir, "planner.jsonl"));

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
    log
  });

  if (opts.dryRun) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`Wrote ${res.tasks.length} tasks to ${outputDir}`);
  }

  log.log(eventWithTs({ type: "plan.cli.complete", tasks: res.tasks.length }));
  log.close();
}
