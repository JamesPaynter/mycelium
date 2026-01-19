import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexRunner } from "./codex.js";

const originalMockFlag = process.env.MOCK_LLM;

describe("MockCodexRunner resume events", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    process.env.MOCK_LLM = originalMockFlag;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("emits codex.thread.resumed on the first turn when resuming an existing thread", async () => {
    process.env.MOCK_LLM = "1";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-"));

    const runner = createCodexRunner({
      codexHome: path.join(tempDir, "codex"),
      workingDirectory: tempDir,
      threadId: "mock-thread-existing",
      taskId: "T-resume",
    });

    const events: string[] = [];
    await runner.streamPrompt("Resume thread", {
      onThreadStarted: (threadId) => {
        events.push(`started:${threadId}`);
      },
      onThreadResumed: (threadId) => {
        events.push(`resumed:${threadId}`);
      },
      onEvent: () => undefined,
    });

    expect(events[0]).toBe("resumed:mock-thread-existing");
    expect(events).not.toContain("started:mock-thread-existing");
  });

  it("emits codex.thread.started on first turn and codex.thread.resumed on the second", async () => {
    process.env.MOCK_LLM = "1";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-"));

    const runner = createCodexRunner({
      codexHome: path.join(tempDir, "codex"),
      workingDirectory: tempDir,
      taskId: "T-new",
    });

    const events: string[] = [];
    await runner.streamPrompt("First turn", {
      onThreadStarted: (threadId) => {
        events.push(`started:${threadId}`);
      },
      onThreadResumed: (threadId) => {
        events.push(`resumed:${threadId}`);
      },
      onEvent: () => undefined,
    });
    await runner.streamPrompt("Second turn", {
      onThreadStarted: (threadId) => {
        events.push(`started:${threadId}`);
      },
      onThreadResumed: (threadId) => {
        events.push(`resumed:${threadId}`);
      },
      onEvent: () => undefined,
    });

    expect(events).toEqual(["started:mock-thread-T-new", "resumed:mock-thread-T-new"]);
  });
});
