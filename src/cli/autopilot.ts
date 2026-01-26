import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import {
  runAutopilotSession,
  writeAutopilotTranscript,
  writePlanningArtifacts,
  type AutopilotIo,
  type AutopilotTranscriptData,
  type AutopilotTranscriptContext,
} from "../core/autopilot.js";
import type { ProjectConfig } from "../core/config.js";
import { runProject } from "../core/executor.js";
import type { PathsContext } from "../core/paths.js";
import { createPlannerClient } from "../core/planner.js";
import { StateStore, summarizeRunState } from "../core/state-store.js";
import { defaultRunId, isoNow } from "../core/utils.js";

import { planProject } from "./plan.js";
import { resolveRunDebugFlags } from "./run-flags.js";
import { createRunStopSignalHandler } from "./signal-handlers.js";

// =============================================================================
// CLI ENTRYPOINT
// =============================================================================

export async function autopilotCommand(
  projectName: string,
  config: ProjectConfig,
  opts: {
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
  },
  appContext?: AppContext,
): Promise<void> {
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
  const sessionId = opts.runId ?? defaultRunId();
  const startedAt = isoNow();

  const planningRoot = resolvePath(config.repo_path, config.planning_dir);
  const planInputDefault = path.join(
    planningRoot,
    "002-implementation",
    "implementation-plan.md",
  );
  const planInputPath = resolvePath(config.repo_path, opts.planInput ?? planInputDefault);
  const transcriptPath = path.join(planningRoot, "sessions", `${sessionId}-autopilot.md`);
  const rel = (p: string): string => path.relative(config.repo_path, p);

  const context: AutopilotTranscriptContext = {
    projectName,
    repoPath: config.repo_path,
    sessionId,
    planInputPath,
    startedAt,
  };

  const client = createPlannerClient(config.planner, projectName, config.repo_path, undefined, paths);
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
  const runDebugFlags = resolveRunDebugFlags(opts);

  const transcriptData: Omit<AutopilotTranscriptData, keyof AutopilotTranscriptContext> = {
    turns: [],
  };

  try {
    io.note(`Autopilot ${sessionId} starting. I will ask a few questions, draft planning files, plan tasks, then run.`);

    const session = await runAutopilotSession({
      client,
      projectName,
      repoPath: config.repo_path,
      sessionId,
      io,
      maxQuestions: opts.maxQuestions,
    });
    transcriptData.turns = session.turns;
    transcriptData.supervisorNote = session.supervisorNote;

    io.note("Drafting planning artifacts...");
    const artifactPaths = await writePlanningArtifacts({
      repoPath: config.repo_path,
      planningRoot,
      sessionId,
      planInputPath,
      artifacts: session.artifacts,
    });
    transcriptData.artifacts = session.artifacts;
    transcriptData.artifactPaths = artifactPaths;
    io.note(`Planning artifacts updated (plan input: ${rel(planInputPath)})`);

    const planResult = await planProject(projectName, config, {
      input: planInputPath,
      output: opts.planOutput,
      dryRun: false,
      runId: sessionId,
    }, appContext);
    transcriptData.plan = {
      tasksPlanned: planResult.tasks.length,
      outputDir: planResult.outputDir,
      planIndexPath: planResult.planIndexPath ?? null,
      dryRun: false,
    };
    io.note(
      `Planner wrote ${planResult.tasks.length} task(s) to ${rel(planResult.outputDir)}${
        planResult.planIndexPath ? ` (index ${rel(planResult.planIndexPath)})` : ""
      }`,
    );

    if (opts.skipRun) {
      transcriptData.runSkipped = true;
      io.note("Run skipped (flagged by operator). Transcript saved with planning outputs.");
      return;
    }

    if (stopHandler.isStopped()) {
      io.note(
        `Run ${sessionId} was stopped before launch. Resume later with: mycelium resume --project ${projectName} --run-id ${sessionId}`,
      );
      transcriptData.runSkipped = true;
      return;
    }

    const stopReporter = startRunProgressReporter(projectName, sessionId, paths);
    try {
      const runResult = await runProject(
        projectName,
        config,
        {
          runId: sessionId,
          maxParallel: opts.maxParallel,
          dryRun: opts.runDryRun,
          buildImage: opts.buildImage,
          useDocker: opts.useDocker,
          stopContainersOnExit: opts.stopContainersOnExit,
          ...runDebugFlags,
          stopSignal: stopHandler.signal,
        },
        paths,
      );

      const summary = summarizeRunState(runResult.state);
      const runStatus = runResult.stopped
        ? "stopped"
        : opts.runDryRun
          ? `${summary.status} (dry-run)`
          : summary.status;
      transcriptData.run = {
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

      if (runResult.stopped) {
        const signalLabel = runResult.stopped.signal ? ` (${runResult.stopped.signal})` : "";
        const containerLabel =
          runResult.stopped.containers === "stopped"
            ? "stopped"
            : "left running for resume";
        io.note(
          `Run ${runResult.runId} stopped by signal${signalLabel}; containers ${containerLabel}. Resume with: mycelium resume --project ${projectName} --run-id ${runResult.runId}`,
        );
      } else {
        io.note(
          `Run ${runResult.runId} completed with status=${runStatus} (${summary.taskCounts.complete}/${summary.taskCounts.total} complete).`,
        );
      }
    } finally {
      stopReporter();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!transcriptData.plan) {
      transcriptData.planError = message;
    } else {
      transcriptData.runError = message;
    }
    throw err;
  } finally {
    io.close();
    stopHandler.cleanup();
    await writeAutopilotTranscript({
      transcriptPath,
      context,
      data: transcriptData,
    });
    io.note(`Transcript saved to ${transcriptPath}`);
  }
}

// =============================================================================
// IO + STATUS
// =============================================================================

class ConsoleAutopilotIo implements AutopilotIo {
  private rl = createInterface({ input, output });

  note(message: string): void {
    console.log(message);
  }

  async ask(question: string): Promise<string> {
    const prompt = question.trim().endsWith("?") ? question.trim() : `${question.trim()}?`;
    const answer = await this.rl.question(`${prompt} `);
    return answer.trim();
  }

  close(): void {
    this.rl.close();
  }
}

function startRunProgressReporter(
  projectName: string,
  runId: string,
  paths: PathsContext,
  intervalMs = 5000,
): () => void {
  const store = new StateStore(projectName, runId, paths);
  let stopped = false;
  let running = false;

  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      try {
        if (!(await store.exists())) return;
        const summary = summarizeRunState(await store.load());
        console.log(
          `[run ${runId}] status=${summary.status}; complete=${summary.taskCounts.complete}/${summary.taskCounts.total}; running=${summary.taskCounts.running}; failed=${summary.taskCounts.failed}; review=${summary.humanReview.length}`,
        );
      } catch {
        // Avoid noisy status spam; rely on run completion output.
      } finally {
        running = false;
      }
    })();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function resolvePath(repoPath: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.join(repoPath, targetPath);
}
