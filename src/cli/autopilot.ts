import type { AppContext } from "../app/context.js";
import { writeAutopilotTranscript } from "../core/autopilot.js";
import type { ProjectConfig } from "../core/config.js";

import {
  buildAutopilotRuntime,
  buildTranscriptContext,
  resolveAutopilotPaths,
  runExecutionStage,
  runPlanningStage,
  type AutopilotOptions,
  type AutopilotTranscriptState,
} from "./autopilot-flow.js";

// =============================================================================
// CLI ENTRYPOINT
// =============================================================================

export async function autopilotCommand(
  projectName: string,
  config: ProjectConfig,
  opts: AutopilotOptions,
  appContext?: AppContext,
): Promise<void> {
  const autopilotPaths = resolveAutopilotPaths(config, opts, appContext);
  const context = buildTranscriptContext(projectName, config, autopilotPaths);
  const runtime = buildAutopilotRuntime(
    projectName,
    config,
    opts,
    autopilotPaths.paths,
    autopilotPaths.sessionId,
  );
  const transcriptData: AutopilotTranscriptState = { turns: [] };

  try {
    runtime.io.note(
      `Autopilot ${autopilotPaths.sessionId} starting. I will ask a few questions, draft planning files, plan tasks, then run.`,
    );

    await runPlanningStage({
      projectName,
      config,
      opts,
      autopilotPaths,
      io: runtime.io,
      client: runtime.client,
      transcriptData,
      appContext,
    });

    await runExecutionStage({
      projectName,
      config,
      opts,
      autopilotPaths,
      runtime,
      transcriptData,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!transcriptData.plan) {
      transcriptData.planError = message;
    } else {
      transcriptData.runError = message;
    }
    throw err;
  } finally {
    runtime.io.close();
    runtime.stopHandler.cleanup();
    await writeAutopilotTranscript({
      transcriptPath: autopilotPaths.transcriptPath,
      context,
      data: transcriptData,
    });
    runtime.io.note(`Transcript saved to ${autopilotPaths.transcriptPath}`);
  }
}
