import fs from "node:fs/promises";
import path from "node:path";

import {
  Codex,
  type ApprovalMode,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";

import { isMockLlmEnabled } from "../src/llm/mock.js";

export type CodexRunnerOptions = {
  codexHome: string;
  model?: string;
  workingDirectory: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  threadId?: string;
  taskId?: string;
  manifestPath?: string;
  specPath?: string;
};

export type CodexRunnerLike = {
  getThreadId(): string | null;
  streamPrompt(
    input: string,
    handlers: {
      onEvent: (event: ThreadEvent) => void;
      onThreadStarted?: (threadId: string) => Promise<void> | void;
      onThreadResumed?: (threadId: string) => Promise<void> | void;
    },
  ): Promise<void>;
};

export function createCodexRunner(opts: CodexRunnerOptions): CodexRunnerLike {
  if (isMockLlmEnabled() || opts.model === "mock") {
    return new MockCodexRunner(opts);
  }
  return new CodexRunner(opts);
}

export class CodexRunner {
  private thread: Thread;
  private readonly resumedThreadId?: string;
  private hasNotifiedThreadStart = false;

  constructor(opts: CodexRunnerOptions) {
    const env: Record<string, string> = {};
    if (opts.codexHome) env.CODEX_HOME = opts.codexHome;
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    const codex = new Codex({ env: Object.keys(env).length > 0 ? env : undefined });
    const threadOptions: ThreadOptions = {
      workingDirectory: opts.workingDirectory,
      sandboxMode: opts.sandboxMode ?? "danger-full-access",
      approvalPolicy: opts.approvalPolicy ?? "never",
    };

    if (opts.model) {
      threadOptions.model = opts.model;
    }

    this.resumedThreadId = opts.threadId;
    this.thread = opts.threadId
      ? codex.resumeThread(opts.threadId, threadOptions)
      : codex.startThread(threadOptions);
  }

  getThreadId(): string | null {
    return this.thread.id;
  }

  async streamPrompt(
    input: string,
    handlers: {
      onEvent: (event: ThreadEvent) => void;
      onThreadStarted?: (threadId: string) => Promise<void> | void;
      onThreadResumed?: (threadId: string) => Promise<void> | void;
    },
  ): Promise<void> {
    if (this.resumedThreadId && this.thread.id) {
      await handlers.onThreadResumed?.(this.thread.id);
    }

    const { events } = await this.thread.runStreamed(input);
    for await (const event of events) {
      if (
        event.type === "thread.started" &&
        !this.resumedThreadId &&
        !this.hasNotifiedThreadStart
      ) {
        this.hasNotifiedThreadStart = true;
        await handlers.onThreadStarted?.(event.thread_id);
      }
      handlers.onEvent(event);
    }
  }
}

class MockCodexRunner {
  private readonly threadId: string;
  private readonly manifestPath?: string;
  private readonly workingDirectory: string;
  private readonly taskId?: string;
  private readonly resumedFromState: boolean;
  private turn = 0;

  constructor(opts: CodexRunnerOptions) {
    this.threadId = opts.threadId ?? `mock-thread-${opts.taskId ?? "task"}`;
    this.manifestPath = opts.manifestPath;
    this.workingDirectory = opts.workingDirectory;
    this.taskId = opts.taskId;
    this.resumedFromState = Boolean(opts.threadId);
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async streamPrompt(
    input: string,
    handlers: {
      onEvent: (event: ThreadEvent) => void;
      onThreadStarted?: (threadId: string) => Promise<void> | void;
      onThreadResumed?: (threadId: string) => Promise<void> | void;
    },
  ): Promise<void> {
    this.turn += 1;

    const isResumeTurn = this.resumedFromState || this.turn > 1;

    if (isResumeTurn) {
      await handlers.onThreadResumed?.(this.threadId);
    } else {
      await handlers.onThreadStarted?.(this.threadId);
    }

    await this.applyMockChanges(input);

    // Optional deterministic token accounting for budget tests.
    // If MOCK_CODEX_USAGE is provided, we emit a synthetic Codex "turn.completed" event
    // that includes usage tokens. The worker loop logs this event as type "codex.event",
    // enabling budget enforcement tests without calling external APIs.
    const usageEvent = this.maybeUsageEvent();
    if (usageEvent) {
      handlers.onEvent(usageEvent);
    }

    const event = {
      type: "mock.event",
      message: `mocked codex output for ${this.taskId ?? "task"}`,
      turn: this.turn,
    } as unknown as ThreadEvent;
    handlers.onEvent(event);
  }

  private maybeUsageEvent(): ThreadEvent | null {
    const raw = process.env.MOCK_CODEX_USAGE;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<{
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
      }>;

      const input = typeof parsed.input_tokens === "number" ? parsed.input_tokens : 0;
      const cached = typeof parsed.cached_input_tokens === "number" ? parsed.cached_input_tokens : 0;
      const output = typeof parsed.output_tokens === "number" ? parsed.output_tokens : 0;

      return {
        type: "turn.completed",
        usage: {
          input_tokens: Math.max(0, input),
          cached_input_tokens: Math.max(0, cached),
          output_tokens: Math.max(0, output),
        },
      } as unknown as ThreadEvent;
    } catch {
      // If a simple integer was provided, treat it as output tokens.
      const numeric = Number(raw);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return {
        type: "turn.completed",
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: numeric,
        },
      } as unknown as ThreadEvent;
    }
  }

  private async applyMockChanges(prompt: string): Promise<void> {
    const targets = await this.resolveWriteTargets();
    if (targets.length === 0) return;

    const content = [
      `Mock update for ${this.taskId ?? "task"} (turn ${this.turn})`,
      prompt.slice(0, 200),
    ]
      .filter(Boolean)
      .join("\n");

    for (const relative of targets) {
      const fullPath = path.join(this.workingDirectory, relative);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, `${content}\n`, "utf8");
    }
  }

  private async resolveWriteTargets(): Promise<string[]> {
    if (!this.manifestPath) return ["mock-output.txt"];

    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(raw) as { files?: { writes?: unknown } };
      const writes = Array.isArray(parsed.files?.writes)
        ? (parsed.files?.writes as string[])
        : [];
      return writes.length > 0 ? writes : ["mock-output.txt"];
    } catch {
      return ["mock-output.txt"];
    }
  }
}
