import type OpenAI from "openai";
import { APIError } from "openai/error";
import type { ChatCompletion, ChatCompletionCreateParams } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";

import { LlmError } from "./client.js";
import { OpenAiClient } from "./openai.js";

class FakeTransport {
  lastBody?: ChatCompletionCreateParams;
  lastOptions?: OpenAI.RequestOptions;

  constructor(private readonly outcome: ChatCompletion | Error) {}

  async create(
    body: ChatCompletionCreateParams,
    options?: OpenAI.RequestOptions,
  ): Promise<ChatCompletion> {
    this.lastBody = body;
    this.lastOptions = options;
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

function makeResponse(content: string): ChatCompletion {
  return {
    id: "chatcmpl-123",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content },
      },
    ],
    created: 1,
    model: "gpt-4o-mini",
    object: "chat.completion",
    service_tier: null,
    system_fingerprint: "fp",
    usage: {
      completion_tokens: 5,
      prompt_tokens: 10,
      total_tokens: 15,
    },
  } as ChatCompletion;
}

describe("OpenAiClient", () => {
  it("sends JSON schema, temperature, and timeout overrides", async () => {
    const schema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    };

    const transport = new FakeTransport(makeResponse('{"status":"ok"}'));
    const client = new OpenAiClient({
      model: "gpt-4o-mini",
      transport,
      defaultTemperature: 0.7,
      defaultTimeoutMs: 30_000,
    });

    const result = await client.complete<{ status: string }>("Hello!", {
      schema,
      temperature: 0.1,
      timeoutMs: 1_500,
    });

    expect(transport.lastBody?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema, strict: true },
    });
    expect(transport.lastBody?.temperature).toBe(0.1);
    expect(transport.lastBody?.messages?.[0]).toEqual({ role: "user", content: "Hello!" });
    expect(transport.lastOptions?.timeout).toBe(1_500);

    expect(result.text).toBe('{"status":"ok"}');
    expect(result.parsed).toEqual({ status: "ok" });
    expect(result.finishReason).toBe("stop");
  });

  it("wraps OpenAI errors with actionable guidance", async () => {
    const apiError = new APIError(
      401,
      { message: "Missing API key" } as Record<string, unknown>,
      "Unauthorized",
      new Headers(),
    );

    const transport = new FakeTransport(apiError);
    const client = new OpenAiClient({ model: "gpt-4o-mini", transport });
    const run = client.complete("Hi there");

    await expect(run).rejects.toBeInstanceOf(LlmError);
    await expect(run).rejects.toThrow(/status 401/i);
    await expect(run).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
