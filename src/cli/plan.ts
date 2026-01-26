import path from "node:path";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { JsonlLogger } from "../core/logger.js";
import { plannerLogPath } from "../core/paths.js";
import { planFromImplementationPlan, type PlanResult } from "../core/planner.js";
import { resolveTasksBacklogDir } from "../core/task-layout.js";
import { defaultRunId } from "../core/utils.js";

export async function planProject(
  projectName: string,
  config: ProjectConfig,
  opts: {
    input: string;
    output?: string;
    dryRun?: boolean;
    runId?: string;
  },
  appContext?: AppContext,
): Promise<PlanResult> {
  const runId = opts.runId ?? defaultRunId();
  const logRunId = `plan-${runId}`;
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
  const log = new JsonlLogger(plannerLogPath(projectName, logRunId, paths), { runId: logRunId });

  try {
    const tasksRoot = path.join(config.repo_path, config.tasks_dir);
    const outputDir = opts.output
      ? path.isAbsolute(opts.output)
        ? opts.output
        : path.join(config.repo_path, opts.output)
      : resolveTasksBacklogDir(tasksRoot);

    const res = await planFromImplementationPlan({
      projectName,
      config,
      inputPath: opts.input,
      outputDir,
      dryRun: opts.dryRun,
      log,
      paths,
    });

    if (opts.dryRun) {
      const ids = res.tasks.map((t) => t.id).join(", ");
      const summary =
        res.tasks.length === 0
          ? "Dry run: no tasks returned by planner."
          : `Dry run: ${res.tasks.length} task(s) planned: ${ids}`;
      console.log(summary);
      return res;
    }

    console.log(`Wrote ${res.tasks.length} task(s) to ${res.outputDir}`);
    if (res.planIndexPath) {
      console.log(`Plan index: ${res.planIndexPath}`);
    }

    log.log({ type: "plan.cli.complete", payload: { tasks: res.tasks.length } });
    return res;
  } finally {
    log.close();
  }
}
