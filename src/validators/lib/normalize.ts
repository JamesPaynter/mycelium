// Validators shared normalization helpers.
// Purpose: keep validator data shaping consistent (LLM output, file samples, and errors).
// Assumes validators emit JSON reports and use markdown-ready prompt formatting.

import path from "node:path";

import type { ZodType } from "zod";

import { LlmError, type LlmCompletionResult } from "../../llm/client.js";

import type { FileSample, TruncateResult } from "./types.js";


// =============================================================================
// COMPLETION NORMALIZATION
// =============================================================================

export function normalizeCompletion<TParsed>(
  completion: LlmCompletionResult<TParsed>,
  schema: ZodType<TParsed>,
  validatorLabel: string,
): TParsed {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new LlmError(`${validatorLabel} validator output failed schema validation: ${detail}`);
  }
  return parsed.data;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LlmError("Validator returned invalid JSON.", err);
  }
}

export function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}


// =============================================================================
// TEXT NORMALIZATION
// =============================================================================

export function truncate(text: string, limit: number): TruncateResult {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit)}\n... [truncated]`, truncated: true };
}

export function uniq(values: string[]): string[] {
  return Array.from(new Set(values)).filter((value) => value.length > 0);
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function secondsToMs(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return value * 1000;
}


// =============================================================================
// FORMAT HELPERS
// =============================================================================

export function formatFilesForPrompt(files: FileSample[]): string {
  if (files.length === 0) {
    return "None";
  }

  return files
    .map((file) => {
      const suffix = file.truncated ? "\n[truncated]" : "";
      return `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`${suffix}`;
    })
    .join("\n\n");
}


// =============================================================================
// ERROR HANDLING
// =============================================================================

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
