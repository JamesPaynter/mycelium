import { LlmClient } from "../llm/client.js";

import type { AutopilotArtifacts, AutopilotTurn } from "./autopilot-types.js";

// =============================================================================
// TYPES
// =============================================================================

type InterviewDecision =
  | { action: "ask"; prompt: string; notes?: string | null }
  | { action: "synthesize"; prompt: string; notes?: string | null };

type ArtifactResponse = {
  artifacts: AutopilotArtifacts;
  readySummary: string;
};

// =============================================================================
// INTERVIEW
// =============================================================================

export async function requestNextInterviewAction(
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

export async function generatePlanningArtifacts(
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

function formatTranscriptForPrompt(turns: AutopilotTurn[]): string {
  return turns
    .map((t) => `${t.role === "supervisor" ? "Supervisor" : "Human"}: ${t.message}`)
    .join("\n");
}
