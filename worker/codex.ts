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
import { execa } from "execa";

import { isMockLlmEnabled } from "../src/llm/mock.js";

// =============================================================================
// TYPES
// =============================================================================

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

export type MockCodexContext = {
  input: string;
  turn: number;
  workingDirectory: string;
};

export type MockCodexHandler = (context: MockCodexContext) => Promise<void> | void;

type ControlGraphCommandUsage = {
  command: string;
  exit_code: number;
};

type ControlGraphProof = {
  mode: "control_graph" | "fallback";
  owner_component_id: string | null;
  owner_root: string | null;
  symbol_query: string;
  symbol_id: string | null;
  symbol_definition_path: string | null;
  used_commands: ControlGraphCommandUsage[];
  errors: string[];
};

type ControlGraphCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  parsedJson: unknown | null;
};

// =============================================================================
// MOCK SUPPORT
// =============================================================================

let mockCodexHandler: MockCodexHandler | null = null;

export function __setMockCodexHandler(handler: MockCodexHandler | null): void {
  mockCodexHandler = handler;
}

// =============================================================================
// MOCK CONTROL GRAPH MODE
// =============================================================================

const CONTROL_GRAPH_SYMBOL_QUERY = "formatUserId";
const CONTROL_GRAPH_OWNER_TARGET = "apps/web/src/index.ts";
const CONTROL_GRAPH_PROOF_PATH = "notes/cg-proof.json";

// =============================================================================
// PUBLIC API
// =============================================================================

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

    if (this.shouldRunControlGraphTestMode()) {
      await this.runControlGraphTestMode(handlers);
      this.emitUsageEvent(handlers);
      this.emitMockEvent(handlers, CONTROL_GRAPH_PROOF_PATH);
      return;
    }

    if (mockCodexHandler) {
      await mockCodexHandler({
        input,
        turn: this.turn,
        workingDirectory: this.workingDirectory,
      });
    } else {
      await this.applyMockChanges(input);
    }

    // Optional deterministic token accounting for budget tests.
    // If MOCK_CODEX_USAGE is provided, we emit a synthetic Codex "turn.completed" event
    // that includes usage tokens. The worker loop logs this event as type "codex.event",
    // enabling budget enforcement tests without calling external APIs.
    this.emitUsageEvent(handlers);
    this.emitMockEvent(handlers, `mocked codex output for ${this.taskId ?? "task"}`);
  }

  private shouldRunControlGraphTestMode(): boolean {
    return process.env.MYCELIUM_TEST_CG === "1" && this.turn === 1;
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
      const cached =
        typeof parsed.cached_input_tokens === "number" ? parsed.cached_input_tokens : 0;
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

  private async runControlGraphTestMode(handlers: {
    onEvent: (event: ThreadEvent) => void;
  }): Promise<void> {
    let proof: ControlGraphProof;

    try {
      proof = await this.buildControlGraphProof(handlers);
    } catch (err) {
      proof = await this.buildFallbackProof([], [this.describeError(err)]);
    }

    try {
      await this.writeControlGraphProof(proof);
    } catch {
      // Best-effort for test mode; avoid failing the worker on proof write errors.
    }
  }

  private async buildControlGraphProof(handlers: {
    onEvent: (event: ThreadEvent) => void;
  }): Promise<ControlGraphProof> {
    const usedCommands: ControlGraphCommandUsage[] = [];
    const errors: string[] = [];

    try {
      const controlGraph = await this.tryControlGraphMode(handlers, usedCommands, errors);
      if (controlGraph) {
        return controlGraph;
      }
    } catch (err) {
      errors.push(this.describeError(err));
    }

    return this.buildFallbackProof(usedCommands, errors);
  }

  private async tryControlGraphMode(
    handlers: { onEvent: (event: ThreadEvent) => void },
    usedCommands: ControlGraphCommandUsage[],
    errors: string[],
  ): Promise<ControlGraphProof | null> {
    const buildResult = await this.runControlGraphCommand(
      handlers,
      ["cg", "build", "--json", "--repo", "."],
      { parseJson: true },
    );
    usedCommands.push({ command: buildResult.command, exit_code: buildResult.exitCode });
    if (buildResult.exitCode !== 0) {
      errors.push(this.describeCommandFailure(buildResult));
      return null;
    }

    const ownerResult = await this.runControlGraphCommand(
      handlers,
      ["cg", "owner", CONTROL_GRAPH_OWNER_TARGET, "--json", "--repo", "."],
      { parseJson: true },
    );
    usedCommands.push({ command: ownerResult.command, exit_code: ownerResult.exitCode });
    if (ownerResult.exitCode !== 0) {
      errors.push(this.describeCommandFailure(ownerResult));
      return null;
    }

    const ownerComponentId = this.readString(
      (ownerResult.parsedJson as { result?: { owner?: { component?: { id?: unknown } } } })?.result
        ?.owner?.component?.id,
    );
    const ownerRoot = this.readString(
      (ownerResult.parsedJson as { result?: { owner?: { root?: unknown } } })?.result?.owner?.root,
    );
    if (!ownerComponentId || !ownerRoot) {
      errors.push("Control graph owner output missing component id or root.");
      return null;
    }

    const symbolsFindResult = await this.runControlGraphCommand(
      handlers,
      [
        "cg",
        "symbols",
        "find",
        CONTROL_GRAPH_SYMBOL_QUERY,
        "--json",
        "--repo",
        ".",
        "--limit",
        "5",
      ],
      { parseJson: true },
    );
    usedCommands.push({
      command: symbolsFindResult.command,
      exit_code: symbolsFindResult.exitCode,
    });
    if (symbolsFindResult.exitCode !== 0) {
      errors.push(this.describeCommandFailure(symbolsFindResult));
      return null;
    }

    const symbolId = this.readString(
      (
        symbolsFindResult.parsedJson as {
          result?: { matches?: Array<{ symbol_id?: unknown }> };
        }
      )?.result?.matches?.[0]?.symbol_id,
    );

    let symbolDefinitionPath: string | null = null;
    if (symbolId) {
      const definitionResult = await this.runControlGraphCommand(
        handlers,
        ["cg", "symbols", "def", symbolId, "--json", "--repo", "."],
        { parseJson: true },
      );
      usedCommands.push({
        command: definitionResult.command,
        exit_code: definitionResult.exitCode,
      });
      if (definitionResult.exitCode !== 0) {
        errors.push(this.describeCommandFailure(definitionResult));
        return null;
      }

      const definition = (
        definitionResult.parsedJson as {
          result?: { definition?: { file?: unknown; location?: { path?: unknown } } };
        }
      )?.result?.definition;
      symbolDefinitionPath =
        this.readString(definition?.location?.path) ?? this.readString(definition?.file);
    }

    return {
      mode: "control_graph",
      owner_component_id: ownerComponentId,
      owner_root: ownerRoot,
      symbol_query: CONTROL_GRAPH_SYMBOL_QUERY,
      symbol_id: symbolId,
      symbol_definition_path: symbolDefinitionPath,
      used_commands: usedCommands,
      errors,
    };
  }

  private async runControlGraphCommand(
    handlers: { onEvent: (event: ThreadEvent) => void },
    args: string[],
    options: { parseJson: boolean },
  ): Promise<ControlGraphCommandResult> {
    const command = ["mycelium", ...args].join(" ");
    handlers.onEvent({ type: "tool.call", tool: "shell", command } as unknown as ThreadEvent);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let parsedJson: unknown | null = null;

    try {
      const result = await execa("mycelium", args, {
        cwd: this.workingDirectory,
        reject: false,
      });
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
      exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
    } catch (err) {
      const resolved = this.normalizeCommandFailure(err);
      exitCode = resolved.exitCode;
      stderr = resolved.stderr;
      handlers.onEvent({
        type: "tool.result",
        tool: "shell",
        command,
        exit_code: exitCode,
        stdout,
        stderr,
      } as unknown as ThreadEvent);
      return { command, exitCode, stdout, stderr, parsedJson };
    }

    if (options.parseJson && exitCode === 0) {
      try {
        parsedJson = JSON.parse(stdout);
      } catch (err) {
        const parseMessage = `Failed to parse JSON output: ${this.describeError(err)}`;
        exitCode = 1;
        stderr = stderr ? `${stderr}\n${parseMessage}` : parseMessage;
      }
    }

    handlers.onEvent({
      type: "tool.result",
      tool: "shell",
      command,
      exit_code: exitCode,
      stdout,
      stderr,
    } as unknown as ThreadEvent);

    return { command, exitCode, stdout, stderr, parsedJson };
  }

  private async buildFallbackProof(
    usedCommands: ControlGraphCommandUsage[],
    errors: string[],
  ): Promise<ControlGraphProof> {
    const symbolDefinitionPath = await this.findFormatUserIdDefinitionPath(errors);

    return {
      mode: "fallback",
      owner_component_id: null,
      owner_root: "apps/web",
      symbol_query: CONTROL_GRAPH_SYMBOL_QUERY,
      symbol_id: null,
      symbol_definition_path: symbolDefinitionPath,
      used_commands: usedCommands,
      errors,
    };
  }

  private async findFormatUserIdDefinitionPath(errors: string[]): Promise<string | null> {
    try {
      const result = await execa("git", ["ls-files"], {
        cwd: this.workingDirectory,
        reject: false,
      });
      if (typeof result.exitCode !== "number" || result.exitCode !== 0) {
        errors.push(`git ls-files failed with exit code ${result.exitCode ?? "unknown"}.`);
        return null;
      }

      const candidates = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.endsWith(".ts"));

      for (const relativePath of candidates) {
        const filePath = path.join(this.workingDirectory, relativePath);
        try {
          const content = await fs.readFile(filePath, "utf8");
          if (content.includes("export function formatUserId")) {
            return relativePath.replace(/\\/g, "/");
          }
        } catch {
          // Best-effort scan; ignore file read errors.
        }
      }
    } catch (err) {
      errors.push(`git ls-files failed: ${this.describeError(err)}`);
    }

    return null;
  }

  private async writeControlGraphProof(proof: ControlGraphProof): Promise<void> {
    const proofPath = path.join(this.workingDirectory, CONTROL_GRAPH_PROOF_PATH);
    await fs.mkdir(path.dirname(proofPath), { recursive: true });
    await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }

  private emitUsageEvent(handlers: { onEvent: (event: ThreadEvent) => void }): void {
    const usageEvent = this.maybeUsageEvent();
    if (usageEvent) {
      handlers.onEvent(usageEvent);
    }
  }

  private emitMockEvent(
    handlers: { onEvent: (event: ThreadEvent) => void },
    message: string,
  ): void {
    const event = {
      type: "mock.event",
      message,
      turn: this.turn,
    } as unknown as ThreadEvent;
    handlers.onEvent(event);
  }

  private describeCommandFailure(result: ControlGraphCommandResult): string {
    if (result.exitCode === 127) {
      return `mycelium not found when running: ${result.command}`;
    }

    if (result.stderr.trim()) {
      return `command failed: ${result.command}: ${result.stderr.trim()}`;
    }

    return `command failed: ${result.command} (exit code ${result.exitCode})`;
  }

  private normalizeCommandFailure(err: unknown): { exitCode: number; stderr: string } {
    const isMissingBinary =
      typeof err === "object" &&
      err &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT";

    if (isMissingBinary) {
      return { exitCode: 127, stderr: "mycelium not found" };
    }

    return { exitCode: 1, stderr: this.describeError(err) };
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
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
      const writes = Array.isArray(parsed.files?.writes) ? (parsed.files?.writes as string[]) : [];
      return writes.length > 0 ? writes : ["mock-output.txt"];
    } catch {
      return ["mock-output.txt"];
    }
  }
}
