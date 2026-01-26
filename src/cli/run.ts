import type { AppContext } from "../app/context.js";
import type { ProjectConfig } from "../core/config.js";
import { runProject, type BatchPlanEntry, type RunOptions } from "../core/executor.js";
import { defaultRunId } from "../core/utils.js";
import { createRunStopSignalHandler } from "./signal-handlers.js";
import {
  closeUiServer,
  launchUiServer,
  maybeOpenUiBrowser,
  resolveUiRuntimeConfig,
  type UiStartResult,
} from "./ui.js";

type RunCommandOptions = RunOptions & {
  ui?: boolean;
  uiPort?: number;
  uiOpen?: boolean;
};

export async function runCommand(
  projectName: string,
  config: ProjectConfig,
  opts: RunCommandOptions,
  appContext?: AppContext,
): Promise<void> {
  const { ui, uiPort, uiOpen, ...runOptions } = opts;
  const runId = runOptions.runId ?? defaultRunId();
  const uiRuntime = resolveUiRuntimeConfig(config.ui, {
    enabled: ui,
    port: uiPort,
    openBrowser: uiOpen,
  });
  const stopHandler = createRunStopSignalHandler({
    onSignal: (signal) => {
      const containerNote = runOptions.stopContainersOnExit
        ? "Stopping task containers before exit."
        : "Leaving task containers running so you can resume.";
      console.log(
        `Received ${signal}. Stopping run ${runId}. ${containerNote} Resume with: mycelium resume --project ${projectName} --run-id ${runId}`,
      );
    },
  });

  let uiStart: UiStartResult | null = null;
  let res: Awaited<ReturnType<typeof runProject>>;
  try {
    uiStart = await launchUiServer({
      projectName,
      runId,
      runtime: uiRuntime,
      onError: "warn",
      appContext,
    });
    if (uiStart) {
      console.log(`UI: ${uiStart.url}`);
      await maybeOpenUiBrowser(uiStart.url, uiRuntime.openBrowser);
    }

    res = await runProject(projectName, config, {
      ...runOptions,
      runId,
      stopSignal: stopHandler.signal,
    });
  } finally {
    stopHandler.cleanup();
    await closeUiServer(uiStart?.handle ?? null);
  }

  if (res.stopped) {
    const signalLabel = res.stopped.signal ? ` (${res.stopped.signal})` : "";
    const containerLabel =
      res.stopped.containers === "stopped" ? "stopped" : "left running for resume";
    console.log(`Run ${res.runId} stopped by signal${signalLabel}; containers ${containerLabel}.`);
    console.log(`Resume with: mycelium resume --project ${projectName} --run-id ${res.runId}`);
    return;
  }

  if (runOptions.dryRun) {
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
