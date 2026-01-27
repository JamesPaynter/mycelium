import path from "node:path";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import {
  runAutopilotSession,
  writePlanningArtifacts,
  type AutopilotIo,
  type AutopilotTranscriptData,
  type AutopilotTranscriptContext,
} from "../core/autopilot.js";
import type { ProjectConfig } from "../core/config.js";
import { runProject } from "../core/executor.js";
import type { PathsContext } from "../core/paths.js";
import { createPlannerClient } from "../core/planner.js";
import { summarizeRunState } from "../core/state-store.js";
import { defaultRunId, isoNow } from "../core/utils.js";

import { ConsoleAutopilotIo, startRunProgressReporter } from "./autopilot-io.js";
import { planProject } from "./plan.js";
import { resolveRunDebugFlags, type RunDebugFlags } from "./run-flags.js";
import { createRunStopSignalHandler } from "./signal-handlers.js";

// =============================================================================
// TYPES
// =============================================================================

export type AutopilotOptions = {
  planInput?: string;
  planOutput?: string;
  runId?: string;
  maxQuestions?: number;
  maxParallel?: number;
  skipRun?: boolean;
  runDryRun?: boolean;
  buildImage?: boolean;
  useDocker?: boolean;
  stopContainersOnExit?: boolean;
} & RunDebugFlags;

export type AutopilotTranscriptState = Omit<
  AutopilotTranscriptData,
  keyof AutopilotTranscriptContext
>;

export type AutopilotPaths = {
  paths: PathsContext;
  sessionId: string;
  startedAt: string;
  planningRoot: string;
  planInputPath: string;
  transcriptPath: string;
  relPath: (targetPath: string) => string;
};

export type AutopilotRuntime = {
  client: ReturnType<typeof createPlannerClient>;
  io: ConsoleAutopilotIo;
  stopHandler: ReturnType<typeof createRunStopSignalHandler>;
  runDebugFlags: RunDebugFlags;
};

type RunProjectResult = Awaited<ReturnType<typeof runProject>>;

type PlanningStageInput = {
  projectName: string;
  config: ProjectConfig;
  opts: AutopilotOptions;
  autopilotPaths: AutopilotPaths;
  io: AutopilotIo;
  client: ReturnType<typeof createPlannerClient>;
  transcriptData: AutopilotTranscriptState;
  appContext?: AppContext;
};

type ExecutionStageInput = {
  projectName: string;
  config: ProjectConfig;
  opts: AutopilotOptions;
  autopilotPaths: AutopilotPaths;
  runtime: AutopilotRuntime;
  transcriptData: AutopilotTranscriptState;
};

// =============================================================================
// PATHS + RUNTIME
// =============================================================================

function resolvePath(repoPath: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.join(repoPath, targetPath);
}

export function resolveAutopilotPaths(
  config: ProjectConfig,
  opts: AutopilotOptions,
  appContext?: AppContext,
): AutopilotPaths {
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
  const sessionId = opts.runId ?? defaultRunId();
  const startedAt = isoNow();

  const planningRoot = resolvePath(config.repo_path, config.planning_dir);
  const planInputDefault = path.join(planningRoot, "002-implementation", "implementation-plan.md");
  const planInputPath = resolvePath(config.repo_path, opts.planInput ?? planInputDefault);
  const transcriptPath = path.join(planningRoot, "sessions", `${sessionId}-autopilot.md`);
  const relPath = (targetPath: string): string => path.relative(config.repo_path, targetPath);

  return {
    paths,
    sessionId,
    startedAt,
    planningRoot,
    planInputPath,
    transcriptPath,
    relPath,
  };
}

export function buildTranscriptContext(
  projectName: string,
  config: ProjectConfig,
  autopilotPaths: AutopilotPaths,
): AutopilotTranscriptContext {
  return {
    projectName,
    repoPath: config.repo_path,
    sessionId: autopilotPaths.sessionId,
    planInputPath: autopilotPaths.planInputPath,
    startedAt: autopilotPaths.startedAt,
  };
}

export function buildAutopilotRuntime(
  projectName: string,
  config: ProjectConfig,
  opts: AutopilotOptions,
  paths: PathsContext,
  sessionId: string,
): AutopilotRuntime {
  const client = createPlannerClient(
    config.planner,
    projectName,
    config.repo_path,
    undefined,
    paths,
  );
  const io = new ConsoleAutopilotIo();
  const stopHandler = createRunStopSignalHandler({
    onSignal: (signal) => {
      const containerNote = opts.stopContainersOnExit
        ? "Stopping task containers before exit."
        : "Leaving task containers running for resume.";
      io.note(
        `Received ${signal}. Stopping run ${sessionId}. ${containerNote} Resume with: mycelium resume --project ${projectName} --run-id ${sessionId}`,
      );
    },
  });
  const runDebugFlags = resolveRunDebugFlags({
    useLegacyEngine: opts.useLegacyEngine,
    crashAfterContainerStart: opts.crashAfterContainerStart,
  });

  return {
    client,
    io,
    stopHandler,
    runDebugFlags,
  };
}

// =============================================================================
// PLANNING STAGE
// =============================================================================

export async function runPlanningStage(input: PlanningStageInput): Promise<void> {
  const { projectName, config, opts, autopilotPaths, io, client, transcriptData, appContext } =
    input;

  const session = await runAutopilotSession({
    client,
    projectName,
    repoPath: config.repo_path,
    sessionId: autopilotPaths.sessionId,
    io,
    maxQuestions: opts.maxQuestions,
  });
  transcriptData.turns = session.turns;
  transcriptData.supervisorNote = session.supervisorNote;

  io.note("Drafting planning artifacts...");
  const artifactPaths = await writePlanningArtifacts({
    repoPath: config.repo_path,
    planningRoot: autopilotPaths.planningRoot,
    sessionId: autopilotPaths.sessionId,
    planInputPath: autopilotPaths.planInputPath,
    artifacts: session.artifacts,
  });
  transcriptData.artifacts = session.artifacts;
  transcriptData.artifactPaths = artifactPaths;
  io.note(
    `Planning artifacts updated (plan input: ${autopilotPaths.relPath(autopilotPaths.planInputPath)})`,
  );

  const planResult = await planProject(
    projectName,
    config,
    {
      input: autopilotPaths.planInputPath,
      output: opts.planOutput,
      dryRun: false,
      runId: autopilotPaths.sessionId,
    },
    appContext,
  );
  transcriptData.plan = {
    tasksPlanned: planResult.tasks.length,
    outputDir: planResult.outputDir,
    planIndexPath: planResult.planIndexPath ?? null,
    dryRun: false,
  };
  io.note(
    `Planner wrote ${planResult.tasks.length} task(s) to ${autopilotPaths.relPath(planResult.outputDir)}${
      planResult.planIndexPath ? ` (index ${autopilotPaths.relPath(planResult.planIndexPath)})` : ""
    }`,
  );
}

// =============================================================================
// EXECUTION STAGE
// =============================================================================

function resolveRunStatus(
  runResult: RunProjectResult,
  summary: ReturnType<typeof summarizeRunState>,
  runDryRun?: boolean,
): string {
  if (runResult.stopped) return "stopped";
  if (runDryRun) return `${summary.status} (dry-run)`;
  return summary.status;
}

function buildRunTranscriptData(
  runResult: RunProjectResult,
  summary: ReturnType<typeof summarizeRunState>,
  runStatus: string,
): AutopilotTranscriptData["run"] {
  return {
    runId: runResult.runId,
    status: runStatus,
    tasks: {
      total: summary.taskCounts.total,
      complete: summary.taskCounts.complete,
      running: summary.taskCounts.running,
      failed: summary.taskCounts.failed,
      needsHuman: summary.humanReview.length,
    },
    stopped:
      runResult.stopped === undefined
        ? undefined
        : {
            signal: runResult.stopped.signal ?? null,
            containers: runResult.stopped.containers,
            stopContainersRequested: runResult.stopped.stopContainersRequested,
          },
  };
}

function reportRunOutcome(
  io: AutopilotIo,
  runResult: RunProjectResult,
  runStatus: string,
  summary: ReturnType<typeof summarizeRunState>,
  projectName: string,
): void {
  if (runResult.stopped) {
    const signalLabel = runResult.stopped.signal ? ` (${runResult.stopped.signal})` : "";
    const containerLabel =
      runResult.stopped.containers === "stopped" ? "stopped" : "left running for resume";
    io.note(
      `Run ${runResult.runId} stopped by signal${signalLabel}; containers ${containerLabel}. Resume with: mycelium resume --project ${projectName} --run-id ${runResult.runId}`,
    );
    return;
  }

  io.note(
    `Run ${runResult.runId} completed with status=${runStatus} (${summary.taskCounts.complete}/${summary.taskCounts.total} complete).`,
  );
}

export async function runExecutionStage(input: ExecutionStageInput): Promise<void> {
  const { projectName, config, opts, autopilotPaths, runtime, transcriptData } = input;

  if (opts.skipRun) {
    transcriptData.runSkipped = true;
    runtime.io.note("Run skipped (flagged by operator). Transcript saved with planning outputs.");
    return;
  }

  if (runtime.stopHandler.isStopped()) {
    runtime.io.note(
      `Run ${autopilotPaths.sessionId} was stopped before launch. Resume later with: mycelium resume --project ${projectName} --run-id ${autopilotPaths.sessionId}`,
    );
    transcriptData.runSkipped = true;
    return;
  }

  const stopReporter = startRunProgressReporter(
    projectName,
    autopilotPaths.sessionId,
    autopilotPaths.paths,
  );
  try {
    const runResult = await runProject(
      projectName,
      config,
      {
        runId: autopilotPaths.sessionId,
        maxParallel: opts.maxParallel,
        dryRun: opts.runDryRun,
        buildImage: opts.buildImage,
        useDocker: opts.useDocker,
        stopContainersOnExit: opts.stopContainersOnExit,
        ...runtime.runDebugFlags,
        stopSignal: runtime.stopHandler.signal,
      },
      autopilotPaths.paths,
    );

    const summary = summarizeRunState(runResult.state);
    const runStatus = resolveRunStatus(runResult, summary, opts.runDryRun);
    transcriptData.run = buildRunTranscriptData(runResult, summary, runStatus);
    reportRunOutcome(runtime.io, runResult, runStatus, summary, projectName);
  } finally {
    stopReporter();
  }
}
