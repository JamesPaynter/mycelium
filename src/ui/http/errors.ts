// UI HTTP error helpers.
// Purpose: centralize the canonical API error payload shape for UI routes.
// Assumes API failures respond with { ok: false, error: { code, message, details? } }.
// Usage: buildApiErrorPayload({ code, message, details }) and buildInternalErrorDetails(err).

import type { CodeGraphError } from "../code-graph.js";

// =============================================================================
// TYPES
// =============================================================================

export type ApiErrorDetails = Record<string, unknown>;

export type ApiErrorPayload = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetails;
  };
};

// =============================================================================
// ERROR BUILDERS
// =============================================================================

export function buildApiErrorPayload(params: {
  code: string;
  message: string;
  details?: ApiErrorDetails;
}): ApiErrorPayload {
  const error = {
    code: params.code,
    message: params.message,
    ...(params.details ? { details: params.details } : {}),
  };

  return { ok: false, error };
}

export function buildCodeGraphErrorPayload(error: CodeGraphError): ApiErrorPayload {
  const details = error.hint ? { hint: error.hint } : undefined;
  return buildApiErrorPayload({ code: error.code, message: error.message, details });
}

export function buildInternalErrorDetails(cause: unknown): ApiErrorDetails {
  const details: ApiErrorDetails = { reason: "unexpected_error" };

  if (!cause || typeof cause !== "object") {
    return details;
  }

  if (!("code" in cause)) {
    return details;
  }

  const errorCode = (cause as { code?: unknown }).code;
  if (typeof errorCode === "string" && errorCode.trim()) {
    details.error_code = errorCode;
  }

  return details;
}
