import fs from "node:fs/promises";
import path from "node:path";

import {
  LlmError,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmCompletionResult,
} from "./client.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isMockLlmEnabled(): boolean {
  const flag = process.env.MOCK_LLM;
  if (!flag) return false;

  return TRUE_VALUES.has(flag.trim().toLowerCase());
}

export class MockLlmClient implements LlmClient {
  private readonly response?: unknown;

  constructor(response?: unknown) {
    this.response = response;
  }

  async complete<TParsed = unknown>(
    _prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<LlmCompletionResult<TParsed>> {
    const payload = await this.loadPayload();
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const parsed = options.schema ? this.parseStructured<TParsed>(payload) : undefined;

    return {
      text,
      parsed,
      finishReason: "mock",
    };
  }

  private async loadPayload(): Promise<unknown> {
    if (this.response !== undefined) {
      return this.response;
    }

    const fixturePath = process.env.MOCK_LLM_OUTPUT_PATH;
    if (fixturePath) {
      return readJsonFixture(fixturePath);
    }

    const inline = process.env.MOCK_LLM_OUTPUT;
    if (inline) {
      return parseInlineJson(inline);
    }

    return { status: "ok", source: "mock-llm" };
  }

  private parseStructured<TParsed>(payload: unknown): TParsed {
    if (typeof payload === "string") {
      return parseInlineJson(payload) as TParsed;
    }
    if (payload && typeof payload === "object") {
      return payload as TParsed;
    }

    throw new LlmError("Mock LLM requires an object payload when a schema is provided.");
  }
}

async function readJsonFixture(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  return parseInlineJson(raw);
}

function parseInlineJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
