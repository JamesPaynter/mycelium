import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import { buildCleanupPlan, executeCleanupPlan, type CleanupPlan } from "../core/cleanup.js";
import type { ProjectConfig } from "../core/config.js";
import { DockerManager } from "../docker/manager.js";

type CleanOptions = {
  runId?: string;
  keepLogs?: boolean;
  force?: boolean;
  dryRun?: boolean;
  removeContainers?: boolean;
};

export async function cleanCommand(
  projectName: string,
  config: ProjectConfig,
  opts: CleanOptions,
  appContext?: AppContext,
): Promise<void> {
  const removeContainers = opts.removeContainers !== false;
  const dockerManager = removeContainers ? new DockerManager() : undefined;
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });

  let plan: CleanupPlan | null;
  try {
    plan = await buildCleanupPlan(projectName, {
      runId: opts.runId,
      keepLogs: opts.keepLogs,
      removeContainers,
      dockerManager,
      paths,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Failed to build cleanup plan: ${detail}`);
    if (removeContainers) {
      console.error("Hint: rerun with --no-containers if Docker is unavailable.");
    }
    process.exitCode = 1;
    return;
  }

  if (!plan) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  if (plan.targets.length === 0 && plan.containers.length === 0) {
    const suffix = removeContainers ? "" : " Containers were not checked (--no-containers).";
    console.log(`Nothing to clean for run ${plan.runId}.${suffix}`);
    return;
  }

  printPlan(plan, { keepLogs: opts.keepLogs ?? false, includeContainers: removeContainers });

  if (opts.dryRun) {
    console.log("Dry run only. No files or containers were removed.");
    return;
  }

  if (!(opts.force ?? false)) {
    const confirmed = await confirmCleanup(plan.runId);
    if (!confirmed) {
      console.log("Cleanup cancelled.");
      return;
    }
  }

  try {
    await executeCleanupPlan(plan, {
      dryRun: false,
      log: (msg) => console.log(msg),
      dockerManager,
    });
    console.log("Cleanup complete.");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Cleanup failed: ${detail}`);
    process.exitCode = 1;
  }
}

function printPlan(
  plan: CleanupPlan,
  opts: { keepLogs: boolean; includeContainers: boolean },
): void {
  console.log(`Cleaning run ${plan.runId} for project ${plan.projectName}:`);

  for (const target of plan.targets) {
    console.log(`- ${target.kind}: ${target.path}`);
  }

  if (plan.containers.length > 0) {
    for (const container of plan.containers) {
      const label = container.name ?? container.id;
      const state = container.state ?? container.status ?? "unknown";
      console.log(`- container: ${label} [state=${state}]`);
    }
  } else if (opts.includeContainers) {
    console.log("- no containers found for this run");
  }

  if (opts.keepLogs && !plan.targets.some((t) => t.kind === "logs")) {
    console.log("- logs retained (--keep-logs)");
  }

  if (!opts.includeContainers) {
    console.log("- containers retained (--no-containers)");
  }
}

async function confirmCleanup(runId: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    console.log("Non-interactive session detected. Re-run with --force to skip confirmation.");
    return false;
  }

  const rl = createInterface({ input, output });
  const answer = await rl.question(`Proceed with deleting artifacts for run ${runId}? (y/N) `);
  rl.close();

  return /^y(es)?$/i.test(answer.trim());
}
