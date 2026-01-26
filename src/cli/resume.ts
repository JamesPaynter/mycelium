import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig } from "../core/config.js";
import { runProject, type RunOptions } from "../core/executor.js";
import { loadRunStateForProject } from "../core/state-store.js";

import { resolveRunDebugFlags, type RunDebugFlags } from "./run-flags.js";
import { createRunStopSignalHandler } from "./signal-handlers.js";
import {
  closeUiServer,
  launchUiServer,
  maybeOpenUiBrowser,
  resolveUiRuntimeConfig,
  type UiStartResult,
} from "./ui.js";

type ResumeOptions = Pick<
  RunOptions,
  | "maxParallel"
  | "dryRun"
  | "buildImage"
  | "useDocker"
  | "stopContainersOnExit"
  | "reuseCompleted"
  | "importRun"
> &
  RunDebugFlags & {
  runId?: string;
  ui?: boolean;
  uiPort?: number;
  uiOpen?: boolean;
};

export async function resumeCommand(
  projectName: string,
  config: ProjectConfig,
  opts: ResumeOptions,
  appContext?: AppContext,
): Promise<void> {
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
  const runDebugFlags = resolveRunDebugFlags({
    useLegacyEngine: opts.useLegacyEngine,
    crashAfterContainerStart: opts.crashAfterContainerStart,
  });
  const resolved = await loadRunStateForProject(projectName, opts.runId, paths);
  if (!resolved) {
    const notFound = opts.runId
      ? `Run ${opts.runId} not found for project ${projectName}.`
      : `No runs found for project ${projectName}.`;
    console.log(notFound);
    return;
  }

  const uiRuntime = resolveUiRuntimeConfig(config.ui, {
    enabled: opts.ui,
    port: opts.uiPort,
    openBrowser: opts.uiOpen,
  });
  const stopHandler = createRunStopSignalHandler({
    onSignal: (signal) => {
      const containerNote = opts.stopContainersOnExit
        ? "Stopping task containers before exit."
        : "Leaving task containers running for resume.";
      console.log(
        `Received ${signal}. Stopping resume for run ${resolved.runId}. ${containerNote} Resume with: mycelium resume --project ${projectName} --run-id ${resolved.runId}`,
      );
    },
  });

  let uiStart: UiStartResult | null = null;
  let res: Awaited<ReturnType<typeof runProject>>;
  try {
    uiStart = await launchUiServer({
      projectName,
      runId: resolved.runId,
      runtime: uiRuntime,
      onError: "warn",
      appContext,
    });
    if (uiStart) {
      console.log(`UI: ${uiStart.url}`);
      await maybeOpenUiBrowser(uiStart.url, uiRuntime.openBrowser);
    }

    res = await runProject(
      projectName,
      config,
      {
        runId: resolved.runId,
        maxParallel: opts.maxParallel,
        dryRun: opts.dryRun,
        buildImage: opts.buildImage,
        useDocker: opts.useDocker,
        stopContainersOnExit: opts.stopContainersOnExit,
        reuseCompleted: opts.reuseCompleted,
        importRun: opts.importRun,
        ...runDebugFlags,
        stopSignal: stopHandler.signal,
        resume: true,
      },
      paths,
    );
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

  console.log(`Run ${res.runId} resumed with status: ${res.state.status}`);
}
