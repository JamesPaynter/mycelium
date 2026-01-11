import type { ProjectConfig } from "../core/config.js";
import { runProject, type BatchPlanEntry, type RunOptions } from "../core/executor.js";

export async function runCommand(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<void> {
  const res = await runProject(projectName, config, opts);

  if (opts.dryRun) {
    printDryRunPlan(res.runId, res.plan);
    return;
  }

  console.log(`Run ${res.runId} finished with status: ${res.state.status}`);
}

function printDryRunPlan(runId: string, plan: BatchPlanEntry[]): void {
  if (plan.length === 0) {
    console.log(`Dry run ${runId}: no pending tasks.`);
    return;
  }

  console.log(`Dry run ${runId}: ${plan.length} batch(es) planned.`);
  for (const batch of plan) {
    const lockText = formatLocks(batch.locks);
    const locksSuffix = lockText ? ` [locks: ${lockText}]` : "";
    console.log(`- Batch ${batch.batchId}: ${batch.taskIds.join(", ")}${locksSuffix}`);
  }
}

function formatLocks(locks: BatchPlanEntry["locks"]): string {
  const reads = locks.reads ?? [];
  const writes = locks.writes ?? [];

  const parts = [];
  if (reads.length > 0) parts.push(`reads=${reads.join(",")}`);
  if (writes.length > 0) parts.push(`writes=${writes.join(",")}`);

  return parts.join("; ");
}
