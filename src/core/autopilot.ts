import path from "node:path";

import fse from "fs-extra";

import { LlmClient } from "../llm/client.js";

import { generatePlanningArtifacts, requestNextInterviewAction } from "./autopilot-artifacts.js";
import { formatAutopilotTranscript } from "./autopilot-transcript.js";
import type {
  AutopilotArtifacts,
  AutopilotArtifactPaths,
  AutopilotIo,
  AutopilotTranscriptContext,
  AutopilotTranscriptData,
  AutopilotTurn,
} from "./autopilot-types.js";
import { writeTextFile } from "./utils.js";

export type {
  AutopilotArtifacts,
  AutopilotArtifactPaths,
  AutopilotIo,
  AutopilotTranscriptContext,
  AutopilotTranscriptData,
  AutopilotTurn,
  PlanExecutionSummary,
  RunExecutionSummary,
} from "./autopilot-types.js";
export { formatAutopilotTranscript } from "./autopilot-transcript.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runAutopilotSession(args: {
  client: LlmClient;
  projectName: string;
  repoPath: string;
  sessionId: string;
  io: AutopilotIo;
  maxQuestions?: number;
}): Promise<{ turns: AutopilotTurn[]; artifacts: AutopilotArtifacts; supervisorNote: string }> {
  const maxQuestions = Math.max(1, args.maxQuestions ?? 5);
  const turns: AutopilotTurn[] = [];

  let supervisorNote: string | null = null;
  let questionsAsked = 0;

  while (questionsAsked < maxQuestions) {
    const decision = await requestNextInterviewAction(args.client, {
      projectName: args.projectName,
      repoPath: args.repoPath,
      turns,
      remaining: maxQuestions - questionsAsked,
    });

    if (decision.prompt.trim().length > 0) {
      turns.push({ role: "supervisor", message: decision.prompt.trim() });
    }

    if (decision.action === "ask") {
      const answer = await args.io.ask(decision.prompt.trim());
      turns.push({ role: "human", message: answer.trim() });
      questionsAsked += 1;
      continue;
    }

    const note = decision.notes?.trim();
    supervisorNote = note ? note : decision.prompt;
    break;
  }

  if (!supervisorNote) {
    supervisorNote = "Interview cap reached; moving to artifact drafting.";
  }

  const artifactResponse = await generatePlanningArtifacts(args.client, {
    projectName: args.projectName,
    repoPath: args.repoPath,
    turns,
  });

  return { turns, artifacts: artifactResponse.artifacts, supervisorNote };
}

export async function writePlanningArtifacts(args: {
  repoPath: string;
  planningRoot?: string;
  sessionId: string;
  planInputPath: string;
  artifacts: AutopilotArtifacts;
}): Promise<AutopilotArtifactPaths> {
  const planningRoot = args.planningRoot ?? path.join(args.repoPath, ".mycelium", "planning");
  const discoveryDir = path.join(planningRoot, "000-discovery");
  const architectureDir = path.join(planningRoot, "001-architecture");
  const implementationDir = path.join(planningRoot, "002-implementation");

  const requirementsPath = path.join(discoveryDir, "requirements.md");
  const researchNotesPath = path.join(discoveryDir, "research-notes.md");
  const apiFindingsPath = path.join(discoveryDir, "api-findings.md");
  const architecturePath = path.join(architectureDir, "architecture.md");
  const decisionsPath = path.join(architectureDir, "decisions.md");
  const infrastructurePath = path.join(architectureDir, "infrastructure.md");
  const implementationPlanPath = args.planInputPath;
  const riskAssessmentPath = path.join(implementationDir, "risk-assessment.md");

  await appendSection(
    requirementsPath,
    "Requirements",
    args.sessionId,
    args.artifacts.discovery.requirements,
  );
  await appendSection(
    researchNotesPath,
    "Research Notes",
    args.sessionId,
    args.artifacts.discovery.researchNotes,
  );
  await appendSection(
    apiFindingsPath,
    "API Findings",
    args.sessionId,
    args.artifacts.discovery.apiFindings,
  );
  await appendSection(
    architecturePath,
    "Architecture",
    args.sessionId,
    args.artifacts.architecture.architecture,
  );
  await appendSection(
    decisionsPath,
    "Decisions",
    args.sessionId,
    args.artifacts.architecture.decisions,
  );
  await appendSection(
    infrastructurePath,
    "Infrastructure",
    args.sessionId,
    args.artifacts.architecture.infrastructure,
  );
  await appendSection(
    implementationPlanPath,
    "Implementation Plan",
    args.sessionId,
    args.artifacts.implementation.plan,
  );
  await appendSection(
    riskAssessmentPath,
    "Risk Assessment",
    args.sessionId,
    args.artifacts.implementation.risks,
  );

  return {
    requirementsPath,
    researchNotesPath,
    apiFindingsPath,
    architecturePath,
    decisionsPath,
    infrastructurePath,
    implementationPlanPath,
    riskAssessmentPath,
  };
}

export async function writeAutopilotTranscript(args: {
  transcriptPath: string;
  context: AutopilotTranscriptContext;
  data: Omit<AutopilotTranscriptData, keyof AutopilotTranscriptContext>;
}): Promise<void> {
  const content = formatAutopilotTranscript({
    ...args.context,
    ...args.data,
  });
  await writeTextFile(args.transcriptPath, content);
}

// =============================================================================
// HELPERS
// =============================================================================

async function appendSection(
  filePath: string,
  title: string,
  sessionId: string,
  body: string,
): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const exists = await fse.pathExists(filePath);
  const prefix = exists ? "\n\n" : `# ${title}\n\n`;
  const sessionHeader = `## Session ${sessionId}\n`;
  const content = `${prefix}${sessionHeader}${body.trim()}\n`;
  await fse.appendFile(filePath, content, "utf8");
}
