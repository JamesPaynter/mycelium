import Anthropic, { APIError, AnthropicError } from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  Tool,
  ToolChoice,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";

import {
  ensureJsonObject,
  LlmClient,
  type LlmCompletionOptions,
  type LlmCompletionResult,
  LlmError,
} from "./client.js";

// =============================================================================
// TYPES
// =============================================================================

type AnthropicTransport = {
  create: (body: MessageCreateParamsNonStreaming, options?: AnthropicRequestOptions) => Promise<Message>;
};

type AnthropicClientOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultTimeoutMs?: number;
  defaultMaxTokens?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  transport?: AnthropicTransport;
};

type AnthropicRequestOptions = {
  timeout?: number;
  maxRetries?: number;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRIABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// =============================================================================
// CLIENT
// =============================================================================

export class AnthropicClient implements LlmClient {
  private readonly model: string;
  private readonly defaultTemperature?: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxTokens: number;
  private readonly maxRetries: number;
  private readonly transport: AnthropicTransport;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model;
    this.defaultTemperature = options.defaultTemperature;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);

    if (!options.transport) {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new LlmError(
          "Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey to AnthropicClient.",
        );
      }

      this.transport = createTransport({
        apiKey,
        baseURL: options.baseURL,
        fetch: options.fetch,
      });
    } else {
      this.transport = options.transport;
    }
  }

  async complete<TParsed = unknown>(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<LlmCompletionResult<TParsed>> {
    if (options.schema !== undefined) {
      ensureJsonObject(options.schema);
    }

    const body = this.buildRequestBody(prompt, options);
    const requestOptions = this.buildRequestOptions(options.timeoutMs);

    const response = await this.runWithRetries(() => this.transport.create(body, requestOptions));
    const finishReason = response.stop_reason ?? null;

    if (options.schema) {
      const parsed = this.extractStructured<TParsed>(response);
      return {
        text: JSON.stringify(parsed),
        parsed,
        finishReason,
      };
    }

    const text = extractText(response.content);
    if (!text) {
      throw new LlmError("Anthropic response did not include assistant content.", response);
    }

    return {
      text,
      finishReason,
    };
  }

  private buildRequestBody(
    prompt: string,
    options: LlmCompletionOptions,
  ): MessageCreateParamsNonStreaming {
    const temperature =
      options.temperature ?? this.defaultTemperature ?? 0; // Deterministic by default for validators.

    const body: MessageCreateParamsNonStreaming = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: this.defaultMaxTokens,
      temperature,
      stream: false,
    };

    if (options.schema) {
      body.tools = [this.buildStructuredOutputTool(options.schema)];
      body.tool_choice = { type: "tool", name: "structured_output" } satisfies ToolChoice;
    }

    return body;
  }

  private buildStructuredOutputTool(schema: Record<string, unknown>): Tool {
    const inputSchema: Tool.InputSchema = { type: "object", ...schema };
    if (inputSchema.type !== "object") {
      throw new LlmError("Anthropic structured outputs require a schema with type \"object\".");
    }

    return {
      name: "structured_output",
      description: "Return JSON that matches the provided schema.",
      input_schema: inputSchema,
      type: "custom",
    };
  }

  private buildRequestOptions(timeoutMs?: number): AnthropicRequestOptions | undefined {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    if (!timeout) return undefined;
    return { timeout };
  }

  private async runWithRetries<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 1;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!this.isRetryable(err) || attempt === this.maxRetries) {
          throw this.wrapError(err);
        }
        await delay(this.retryDelayMs(attempt));
      }
      attempt += 1;
    }

    throw this.wrapError(lastError ?? new Error("Unknown Anthropic failure"));
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof APIError) {
      if (error.status === undefined) return false;
      return RETRIABLE_STATUS_CODES.has(error.status);
    }
    if (error instanceof AnthropicError) {
      return false;
    }
    if (error instanceof Error) {
      return error.message.toLowerCase().includes("timeout") || error.message.includes("ETIMEDOUT");
    }
    return false;
  }

  private retryDelayMs(attempt: number): number {
    const capped = Math.min(attempt, 5);
    return 250 * 2 ** (capped - 1);
  }

  private extractStructured<T>(message: Message): T {
    const block = message.content.find((part) => part.type === "tool_use") as ToolUseBlock | undefined;
    if (!block) {
      throw new LlmError("Anthropic response did not include a tool_use block for structured output.", message);
    }

    ensureJsonObject(block.input);
    return block.input as T;
  }

  private wrapError(error: unknown): LlmError {
    if (error instanceof APIError) {
      const status = error.status ?? "unknown";
      const detail =
        error.error && typeof error.error === "object" && "message" in error.error
          ? String((error.error as Record<string, unknown>).message)
          : error.message;
      const hint =
        status === 401 || status === 403
          ? "Check ANTHROPIC_API_KEY and permissions."
          : status === 429
            ? "Rate limited by Anthropic."
            : null;
      const suffix = hint ? ` ${hint}` : "";
      return new LlmError(`Anthropic request failed (status ${status}): ${detail}${suffix}`, error);
    }

    if (error instanceof AnthropicError) {
      return new LlmError(`Anthropic request failed: ${error.message}`, error);
    }

    if (error instanceof Error) {
      return new LlmError(error.message, error);
    }

    return new LlmError("Anthropic request failed due to an unknown error.", error);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function createTransport(args: {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): AnthropicTransport {
  const client = new Anthropic({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    fetch: args.fetch,
    maxRetries: 0, // Manual retries handled in AnthropicClient.
  });

  return {
    create: async (body, options) => {
      return client.messages.create({ ...body, stream: false }, options);
    },
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking" && "thinking" in block) return (block as { thinking: string }).thinking;
      if (block.type === "redacted_thinking" && "thinking" in block) {
        return (block as { thinking: string }).thinking;
      }
      return "";
    })
    .join("")
    .trim();
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
