import { OrchestratorError } from "../core/errors.js";

// =============================================================================
// TYPES
// =============================================================================

export type LlmProvider = "openai" | "anthropic" | "codex";

export type LlmCompletionOptions = {
  schema?: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
};

export type LlmCompletionResult<TParsed = unknown> = {
  text: string;
  parsed?: TParsed;
  finishReason: string | null;
};

export interface LlmClient {
  complete<TParsed = unknown>(
    prompt: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult<TParsed>>;
}

// =============================================================================
// ERRORS
// =============================================================================

export class LlmError extends OrchestratorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LlmError";
  }
}

// =============================================================================
// HELPERS
// =============================================================================

export function ensureJsonObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmError("Structured output schema must be a plain JSON object.");
  }
}
