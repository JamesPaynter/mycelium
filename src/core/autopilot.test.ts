import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatAutopilotTranscript,
  runAutopilotSession,
  writePlanningArtifacts,
  type AutopilotIo,
  type AutopilotArtifacts,
} from "./autopilot.js";
import { type LlmClient, type LlmCompletionResult, type LlmCompletionOptions } from "../llm/client.js";

class StubLlmClient implements LlmClient {
  constructor(private readonly responses: Array<LlmCompletionResult<any>>) {}

  async complete<TParsed = unknown>(
    _prompt: string,
    _options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult<TParsed>> {
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No more stub responses available.");
    }
    return next as LlmCompletionResult<TParsed>;
  }
}

class StubIo implements AutopilotIo {
  public readonly asked: string[] = [];

  note(): void {}

  async ask(question: string): Promise<string> {
    this.asked.push(question);
    return "stub-response";
  }
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("runAutopilotSession", () => {
  it("asks questions and produces artifacts with stubbed LLM responses", async () => {
    const io = new StubIo();
    const artifacts: AutopilotArtifacts = {
      discovery: {
        requirements: "- need a CLI",
        researchNotes: "- researched notes",
        apiFindings: "- api details",
      },
      architecture: {
        architecture: "- hexagonal",
        decisions: "- pick postgres",
        infrastructure: "- docker compose",
      },
      implementation: {
        plan: "- step one",
        risks: "- risk one",
      },
      summary: "short summary",
    };

    const responses: Array<LlmCompletionResult<any>> = [
      { text: "", parsed: { action: "ask", prompt: "What is the goal?" }, finishReason: "stop" },
      { text: "", parsed: { action: "synthesize", prompt: "Ready to plan." }, finishReason: "stop" },
      {
        text: "",
        parsed: { artifacts, readySummary: "done" },
        finishReason: "stop",
      },
    ];

    const client = new StubLlmClient(responses);

    const session = await runAutopilotSession({
      client,
      projectName: "demo",
      repoPath: "/repo",
      sessionId: "session-1",
      io,
      maxQuestions: 3,
    });

    expect(io.asked).toEqual(["What is the goal?"]);
    expect(session.turns).toHaveLength(3);
    expect(session.turns[0].role).toBe("supervisor");
    expect(session.turns[1].role).toBe("human");
    expect(session.turns[2].role).toBe("supervisor");
    expect(session.artifacts.summary).toContain("short summary");
  });
});

describe("writePlanningArtifacts + transcript formatting", () => {
  it("writes planning files and formats transcript paths relative to repo", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-"));
    tmpDirs.push(repo);

    const artifacts: AutopilotArtifacts = {
      discovery: {
        requirements: "reqs",
        researchNotes: "notes",
        apiFindings: "apis",
      },
      architecture: {
        architecture: "arch",
        decisions: "decisions",
        infrastructure: "infra",
      },
      implementation: {
        plan: "plan-body",
        risks: "risks-body",
      },
      summary: "overall summary",
    };

    const planInputPath = path.join(repo, "docs", "planning", "002-implementation", "implementation-plan.md");
    const paths = await writePlanningArtifacts({
      repoPath: repo,
      sessionId: "20250101-000000",
      planInputPath,
      artifacts,
    });

    const transcript = formatAutopilotTranscript({
      projectName: "demo",
      repoPath: repo,
      sessionId: "20250101-000000",
      planInputPath,
      startedAt: "2025-01-01T00:00:00Z",
      turns: [],
      artifacts,
      artifactPaths: paths,
      plan: {
        tasksPlanned: 3,
        outputDir: path.join(repo, ".tasks"),
        planIndexPath: null,
        dryRun: false,
      },
      runSkipped: true,
    });

    const planFile = fs.readFileSync(paths.implementationPlanPath, "utf8");
    expect(planFile).toContain("# Implementation Plan");
    expect(planFile).toContain("Session 20250101-000000");
    expect(transcript).toContain("planning/002-implementation/implementation-plan.md");
    expect(transcript).toContain("tasks=3");
    expect(transcript).toContain("Run skipped by operator.");
  });
});
