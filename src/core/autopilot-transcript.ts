import path from "node:path";

import type { AutopilotTranscriptData } from "./autopilot-types.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export function formatAutopilotTranscript(data: AutopilotTranscriptData): string {
  const lines: string[] = [];
  const relative = (value: string): string => path.relative(data.repoPath, value);

  appendTranscriptHeader(lines, data, relative);
  appendSupervisorNote(lines, data);
  appendPlanningArtifacts(lines, data, relative);
  appendConversation(lines, data);
  appendPlannerSummary(lines, data, relative);
  appendRunSummary(lines, data);

  return lines.join("\n").trimEnd() + "\n";
}

// =============================================================================
// SECTION BUILDERS
// =============================================================================

type RelativePath = (value: string) => string;

function appendTranscriptHeader(
  lines: string[],
  data: AutopilotTranscriptData,
  relative: RelativePath,
): void {
  lines.push(`# Autopilot Session ${data.sessionId}`);
  lines.push("");
  lines.push(`- Project: ${data.projectName}`);
  lines.push(`- Started: ${data.startedAt}`);
  lines.push(`- Plan input: ${relative(data.planInputPath)}`);
  lines.push("");
}

function appendSupervisorNote(lines: string[], data: AutopilotTranscriptData): void {
  if (!data.supervisorNote) {
    return;
  }

  lines.push(`> Supervisor note: ${data.supervisorNote}`);
  lines.push("");
}

function appendPlanningArtifacts(
  lines: string[],
  data: AutopilotTranscriptData,
  relative: RelativePath,
): void {
  if (!data.artifacts || !data.artifactPaths) {
    return;
  }

  lines.push("## Planning artifacts");
  lines.push("");
  lines.push(`- Discovery → requirements: ${relative(data.artifactPaths.requirementsPath)}`);
  lines.push(`- Discovery → research: ${relative(data.artifactPaths.researchNotesPath)}`);
  lines.push(`- Discovery → API findings: ${relative(data.artifactPaths.apiFindingsPath)}`);
  lines.push(`- Architecture → architecture: ${relative(data.artifactPaths.architecturePath)}`);
  lines.push(`- Architecture → decisions: ${relative(data.artifactPaths.decisionsPath)}`);
  lines.push(`- Architecture → infrastructure: ${relative(data.artifactPaths.infrastructurePath)}`);
  lines.push(`- Implementation → plan: ${relative(data.artifactPaths.implementationPlanPath)}`);
  lines.push(`- Implementation → risks: ${relative(data.artifactPaths.riskAssessmentPath)}`);
  lines.push("");
  lines.push("### Draft summary");
  lines.push("");
  lines.push(data.artifacts.summary.trim());
  lines.push("");
}

function appendConversation(lines: string[], data: AutopilotTranscriptData): void {
  lines.push("## Conversation");
  lines.push("");

  if (data.turns.length === 0) {
    lines.push("_No questions asked._");
  } else {
    data.turns.forEach((turn, idx) => {
      const speaker = turn.role === "supervisor" ? "Supervisor" : "Human";
      lines.push(`${idx + 1}. **${speaker}:** ${turn.message}`);
    });
  }

  lines.push("");
}

function appendPlannerSummary(
  lines: string[],
  data: AutopilotTranscriptData,
  relative: RelativePath,
): void {
  lines.push("## Planner");
  lines.push("");

  if (data.plan) {
    const planSummary = [
      `tasks=${data.plan.tasksPlanned}`,
      `output=${relative(data.plan.outputDir)}`,
      `mode=${data.plan.dryRun ? "dry-run" : "write"}`,
    ];
    if (data.plan.planIndexPath) {
      planSummary.push(`index=${relative(data.plan.planIndexPath)}`);
    }
    lines.push(`- ${planSummary.join("; ")}`);
  } else if (data.planError) {
    lines.push(`- Failed: ${data.planError}`);
  } else {
    lines.push("- Skipped planning.");
  }

  lines.push("");
}

function appendRunSummary(lines: string[], data: AutopilotTranscriptData): void {
  lines.push("## Run");
  lines.push("");

  if (data.runSkipped) {
    lines.push("- Run skipped by operator.");
    return;
  }

  if (data.run) {
    const parts = [`run_id=${data.run.runId}`, `status=${data.run.status}`];
    if (data.run.tasks) {
      parts.push(
        `tasks=${data.run.tasks.complete}/${data.run.tasks.total} complete; running=${data.run.tasks.running}; failed=${data.run.tasks.failed}; review=${data.run.tasks.needsHuman}`,
      );
    }
    if (data.run.stopped) {
      const stopped = data.run.stopped;
      const signal = stopped.signal ?? "unknown";
      parts.push(
        `stopped=signal:${signal}, containers:${stopped.containers}, requested_stop:${stopped.stopContainersRequested}`,
      );
    }
    if (data.run.error) {
      parts.push(`error=${data.run.error}`);
    }
    lines.push(`- ${parts.join("; ")}`);
    return;
  }

  if (data.runError) {
    lines.push(`- Failed: ${data.runError}`);
    return;
  }

  lines.push("- Run not started.");
}
