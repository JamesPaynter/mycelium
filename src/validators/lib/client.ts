// Validators shared LLM client helpers.
// Purpose: centralize provider selection and default option handling for validators.
// Assumes validator configs follow the core ValidatorConfig shape.

import type { ValidatorConfig } from "../../core/config.js";
import { AnthropicClient } from "../../llm/anthropic.js";
import type { LlmClient } from "../../llm/client.js";
import { MockLlmClient, isMockLlmEnabled } from "../../llm/mock.js";
import { OpenAiClient } from "../../llm/openai.js";

import { secondsToMs } from "./normalize.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export function createValidatorClient(cfg: ValidatorConfig): LlmClient {
  if (isMockLlmEnabled() || cfg.provider === "mock") {
    return new MockLlmClient();
  }

  if (cfg.provider === "openai") {
    return new OpenAiClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
    });
  }

  if (cfg.provider === "anthropic") {
    return new AnthropicClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature ?? 0,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
      apiKey: cfg.anthropic_api_key,
      baseURL: cfg.anthropic_base_url,
    });
  }

  throw new Error(`Unsupported validator provider: ${cfg.provider}`);
}
