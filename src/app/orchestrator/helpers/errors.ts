/*
Pure error helpers shared by the orchestrator executor.
Assumes callers only need string representations for logs and summaries.
*/

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
