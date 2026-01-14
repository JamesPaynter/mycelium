import {
  Codex,
  type ApprovalMode,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";

export type CodexRunnerOptions = {
  codexHome: string;
  model?: string;
  workingDirectory: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  threadId?: string;
};

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
