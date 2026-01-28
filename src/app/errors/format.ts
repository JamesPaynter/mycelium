/*
Purpose: shared error formatting helpers for logs and summaries.
Assumptions: callers only need string representations.
Usage: formatErrorMessage(err), normalizeAbortReason(reason).
*/

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function normalizeAbortReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;

  if (typeof reason === "object") {
    const value = reason as Record<string, unknown>;
    if (typeof value.signal === "string") return value.signal;
    if (typeof value.type === "string") return value.type;
  }

  return String(reason);
}
