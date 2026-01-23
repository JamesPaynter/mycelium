// Codex SDK supports an optional "model_reasoning_effort" configuration key.
//
// Mycelium exposes this as worker.reasoning_effort to:
// - let operators tune reasoning for cost/speed/quality trade-offs
// - keep the decision centralized (one place that understands the allowed values)
//
// We keep the logic conservative: if no explicit value is provided, we return
// undefined and allow Codex defaults to apply.

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export function resolveCodexReasoningEffort(
  _model: string,
  configured?: CodexReasoningEffort,
): CodexReasoningEffort | undefined {
  // Today we intentionally do not attempt to infer model support.
  // Different model families may ignore unknown keys or error; operators can
  // set worker.reasoning_effort explicitly when they know a model supports it.
  return configured;
}
