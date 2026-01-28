import { OrchestratorError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

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
// USER-FACING ERROR HELPERS
// =============================================================================

const STRUCTURED_OUTPUT_SCHEMA_HINT = "Provide a JSON schema object for structured output.";
const STRUCTURED_OUTPUT_RESPONSE_HINT = "Retry the request or simplify the schema.";
const RESPONSE_HINT = "Retry the request or check the provider status.";

type ProviderApiKeyInfo = {
  label: string;
  envVar: string;
  clientName?: string;
};

const PROVIDER_API_KEYS: Record<LlmProvider, ProviderApiKeyInfo> = {
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY", clientName: "OpenAiClient" },
  anthropic: { label: "Anthropic", envVar: "ANTHROPIC_API_KEY", clientName: "AnthropicClient" },
  codex: { label: "Codex", envVar: "CODEX_API_KEY" },
};

export function createMissingApiKeyError(provider: LlmProvider, cause?: unknown): UserFacingError {
  const info = PROVIDER_API_KEYS[provider];
  const hint = formatApiKeyHint(info);
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.config,
    title: `${info.label} API key missing.`,
    message: `${info.label} API key is missing or invalid.`,
    hint,
    cause,
  });
}

export function createStructuredOutputSchemaError(
  message: string,
  cause?: unknown,
): UserFacingError {
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: "Structured output schema invalid.",
    message,
    hint: STRUCTURED_OUTPUT_SCHEMA_HINT,
    cause,
  });
}

export function createStructuredOutputResponseError(
  provider: LlmProvider,
  message: string,
  cause?: unknown,
): UserFacingError {
  const label = PROVIDER_API_KEYS[provider]?.label ?? "LLM";
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: `${label} structured output invalid.`,
    message,
    hint: STRUCTURED_OUTPUT_RESPONSE_HINT,
    cause,
  });
}

export function createResponseError(
  provider: LlmProvider,
  message: string,
  cause?: unknown,
): UserFacingError {
  const label = PROVIDER_API_KEYS[provider]?.label ?? "LLM";
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: `${label} response invalid.`,
    message,
    hint: RESPONSE_HINT,
    cause,
  });
}

function formatApiKeyHint(info: ProviderApiKeyInfo): string {
  const clientHint = info.clientName ? ` or pass apiKey to ${info.clientName}` : "";
  return `Set ${info.envVar}${clientHint}.`;
}

// =============================================================================
// HELPERS
// =============================================================================

export function ensureJsonObject(
  value: unknown,
  errorFactory: () => Error = () =>
    new LlmError("Structured output schema must be a plain JSON object."),
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errorFactory();
  }
}
