import path from "node:path";

import fse from "fs-extra";

import { LlmClient } from "../llm/client.js";
import { writeTextFile } from "./utils.js";

// =============================================================================
// TYPES
// =============================================================================

export type AutopilotTurn = {
  role: "supervisor" | "human";
  message: string;
};

export type AutopilotArtifacts = {
  discovery: {
    requirements: string;
    researchNotes: string;
    apiFindings: string;
  };
  architecture: {
    architecture: string;
    decisions: string;
    infrastructure: string;
  };
  implementation: {
    plan: string;
    risks: string;
  };
  summary: string;
};

export type AutopilotArtifactPaths = {
  requirementsPath: string;
  researchNotesPath: string;
  apiFindingsPath: string;
  architecturePath: string;
  decisionsPath: string;
  infrastructurePath: string;
  implementationPlanPath: string;
  riskAssessmentPath: string;
};

export type PlanExecutionSummary = {
  tasksPlanned: number;
  outputDir: string;
  planIndexPath?: string | null;
  dryRun: boolean;
};

export type RunExecutionSummary = {
  runId: string;
  status: string;
  tasks?: {
    total: number;
    complete: number;
    running: number;
    failed: number;
    needsHuman: number;
  };
  error?: string;
  stopped?: {
    signal: string | null;
    containers: "left_running" | "stopped";
    stopContainersRequested: boolean;
  };
};

export type AutopilotTranscriptContext = {
  projectName: string;
  repoPath: string;
  sessionId: string;
  planInputPath: string;
  startedAt: string;
};

export type AutopilotTranscriptData = AutopilotTranscriptContext & {
  turns: AutopilotTurn[];
  artifacts?: AutopilotArtifacts;
  artifactPaths?: AutopilotArtifactPaths;
  supervisorNote?: string | null;
  plan?: PlanExecutionSummary;
  planError?: string;
  run?: RunExecutionSummary;
  runSkipped?: boolean;
  runError?: string;
};

export interface AutopilotIo {
  ask(question: string): Promise<string>;
  note(message: string): void;
}

type InterviewDecision =
  | { action: "ask"; prompt: string; notes?: string | null }
  | { action: "synthesize"; prompt: string; notes?: string | null };

type ArtifactResponse = {
  artifacts: AutopilotArtifacts;
  readySummary: string;
};

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

export function formatAutopilotTranscript(data: AutopilotTranscriptData): string {
  const lines: string[] = [];
  const relative = (p: string): string => path.relative(data.repoPath, p);

  lines.push(`# Autopilot Session ${data.sessionId}`);
  lines.push("");
  lines.push(`- Project: ${data.projectName}`);
  lines.push(`- Started: ${data.startedAt}`);
  lines.push(`- Plan input: ${relative(data.planInputPath)}`);
  lines.push("");

  if (data.supervisorNote) {
    lines.push(`> Supervisor note: ${data.supervisorNote}`);
    lines.push("");
  }

  if (data.artifacts && data.artifactPaths) {
    lines.push("## Planning artifacts");
    lines.push("");
    lines.push(`- Discovery → requirements: ${relative(data.artifactPaths.requirementsPath)}`);
    lines.push(`- Discovery → research: ${relative(data.artifactPaths.researchNotesPath)}`);
    lines.push(`- Discovery → API findings: ${relative(data.artifactPaths.apiFindingsPath)}`);
    lines.push(`- Architecture → architecture: ${relative(data.artifactPaths.architecturePath)}`);
    lines.push(`- Architecture → decisions: ${relative(data.artifactPaths.decisionsPath)}`);
    lines.push(
      `- Architecture → infrastructure: ${relative(data.artifactPaths.infrastructurePath)}`,
    );
    lines.push(`- Implementation → plan: ${relative(data.artifactPaths.implementationPlanPath)}`);
    lines.push(`- Implementation → risks: ${relative(data.artifactPaths.riskAssessmentPath)}`);
    lines.push("");
    lines.push("### Draft summary");
    lines.push("");
    lines.push(data.artifacts.summary.trim());
    lines.push("");
  }

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

  lines.push("## Run");
  lines.push("");
  if (data.runSkipped) {
    lines.push("- Run skipped by operator.");
  } else if (data.run) {
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
    if (data.run.error) parts.push(`error=${data.run.error}`);
    lines.push(`- ${parts.join("; ")}`);
  } else if (data.runError) {
    lines.push(`- Failed: ${data.runError}`);
  } else {
    lines.push("- Run not started.");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// =============================================================================
// INTERVIEW
// =============================================================================

async function requestNextInterviewAction(
  client: LlmClient,
  args: {
    projectName: string;
    repoPath: string;
    turns: AutopilotTurn[];
    remaining: number;
  },
): Promise<InterviewDecision> {
  const transcript = formatTranscriptForPrompt(args.turns);
  const prompt = [
    "You are the Autopilot supervisor for a software project.",
    "Ask concise, targeted questions to understand goals, constraints, risks, and deliverables.",
    "Stop asking when you have enough context to propose a plan.",
    "",
    `Project: ${args.projectName}`,
    `Repo: ${args.repoPath}`,
    `Questions remaining: ${args.remaining}`,
    "",
    "Return JSON with:",
    `- action: "ask" or "synthesize"`,
    "- prompt: the next question or a short acknowledgment before planning",
    "- notes: optional rationale (use empty string if none)",
    "",
    "Transcript:",
    transcript || "<empty>",
  ].join("\n");

  const result = await client.complete<InterviewDecision>(prompt, {
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["ask", "synthesize"] },
        prompt: { type: "string" },
        notes: { type: "string" },
      },
      required: ["action", "prompt", "notes"],
      additionalProperties: false,
    },
    temperature: 0.2,
  });

  if (result.parsed) {
    return result.parsed;
  }

  return { action: "synthesize", prompt: result.text };
}

// =============================================================================
// ARTIFACT GENERATION
// =============================================================================

async function generatePlanningArtifacts(
  client: LlmClient,
  args: { projectName: string; repoPath: string; turns: AutopilotTurn[] },
): Promise<ArtifactResponse> {
  const transcript = formatTranscriptForPrompt(args.turns);
  const prompt = [
    "You are drafting planning artifacts after an interview.",
    "Keep output short, scannable, and specific to the conversation.",
    "",
    `Project: ${args.projectName}`,
    `Repo: ${args.repoPath}`,
    "",
    "Transcript:",
    transcript || "<empty>",
    "",
    "Produce Markdown for:",
    "- readySummary (1-2 short sentences; can be empty)",
    "- discovery.requirements",
    "- discovery.research_notes",
    "- discovery.api_findings",
    "- architecture.architecture",
    "- architecture.decisions",
    "- architecture.infrastructure",
    "- implementation.plan (feeds a planner, so list concrete work items and constraints)",
    "- implementation.risks",
    "- summary (1-2 short paragraphs)",
  ].join("\n");

  const response = await client.complete<ArtifactResponse>(prompt, {
    schema: buildArtifactSchema(),
    temperature: 0.3,
  });

  const parsed = response.parsed;
  if (!parsed?.artifacts) {
    throw new Error("Autopilot did not return planning artifacts.");
  }

  const normalized: AutopilotArtifacts = {
    discovery: {
      requirements: parsed.artifacts.discovery.requirements.trim(),
      researchNotes: parsed.artifacts.discovery.researchNotes.trim(),
      apiFindings: parsed.artifacts.discovery.apiFindings.trim(),
    },
    architecture: {
      architecture: parsed.artifacts.architecture.architecture.trim(),
      decisions: parsed.artifacts.architecture.decisions.trim(),
      infrastructure: parsed.artifacts.architecture.infrastructure.trim(),
    },
    implementation: {
      plan: parsed.artifacts.implementation.plan.trim(),
      risks: parsed.artifacts.implementation.risks.trim(),
    },
    summary: parsed.artifacts.summary.trim(),
  };

  return { artifacts: normalized, readySummary: parsed.readySummary ?? "" };
}

function buildArtifactSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      readySummary: { type: "string" },
      artifacts: {
        type: "object",
        properties: {
          discovery: {
            type: "object",
            properties: {
              requirements: { type: "string" },
              researchNotes: { type: "string" },
              apiFindings: { type: "string" },
            },
            required: ["requirements", "researchNotes", "apiFindings"],
            additionalProperties: false,
          },
          architecture: {
            type: "object",
            properties: {
              architecture: { type: "string" },
              decisions: { type: "string" },
              infrastructure: { type: "string" },
            },
            required: ["architecture", "decisions", "infrastructure"],
            additionalProperties: false,
          },
          implementation: {
            type: "object",
            properties: {
              plan: { type: "string" },
              risks: { type: "string" },
            },
            required: ["plan", "risks"],
            additionalProperties: false,
          },
          summary: { type: "string" },
        },
        required: ["discovery", "architecture", "implementation", "summary"],
        additionalProperties: false,
      },
    },
    required: ["readySummary", "artifacts"],
    additionalProperties: false,
  };
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

function formatTranscriptForPrompt(turns: AutopilotTurn[]): string {
  return turns
    .map((t) => `${t.role === "supervisor" ? "Supervisor" : "Human"}: ${t.message}`)
    .join("\n");
}
