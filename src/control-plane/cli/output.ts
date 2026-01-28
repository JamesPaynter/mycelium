export const CONTROL_PLANE_ERROR_CODES = {
  modelNotBuilt: "MODEL_NOT_BUILT",
  notImplemented: "NOT_IMPLEMENTED",
  modelStoreError: "MODEL_STORE_ERROR",
  symbolRefsUnavailable: "SYMBOL_REFS_UNAVAILABLE",
  policyEvalError: "POLICY_EVAL_ERROR",
} as const;

const MODEL_NOT_BUILT_MESSAGE = "Control plane model not built.";
const MODEL_NOT_BUILT_HINT = "Run `mycelium cp build` to generate it.";

export type ControlPlaneErrorCode =
  (typeof CONTROL_PLANE_ERROR_CODES)[keyof typeof CONTROL_PLANE_ERROR_CODES];

// =============================================================================
// JSON SHAPES
// =============================================================================

export type ControlPlaneJsonError = {
  code: ControlPlaneErrorCode;
  message: string;
  details: Record<string, unknown> | null;
  hint?: string;
};

export type ControlPlaneJsonEnvelope<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      error: ControlPlaneJsonError;
    };

export type ControlPlaneOutputOptions = {
  useJson: boolean;
  prettyJson: boolean;
  debug?: boolean;
};

// =============================================================================
// OUTPUT EMITTERS
// =============================================================================

export function emitControlPlaneResult<T>(result: T, output: ControlPlaneOutputOptions): void {
  if (output.useJson) {
    writeJson({ ok: true, result }, output);
    return;
  }

  if (result !== undefined) {
    console.log(result);
  }
}

export function emitControlPlaneError(
  error: ControlPlaneJsonError,
  output: ControlPlaneOutputOptions,
): void {
  const debug = resolveDebugEnabled(output);
  const normalized = normalizeError(error, { debug });

  if (output.useJson) {
    writeJson({ ok: false, error: normalized }, output);
  } else {
    console.error(renderControlPlaneError(normalized, { debug }));
  }

  process.exitCode = 1;
}

export function emitModelNotBuiltError(
  message: string,
  output: ControlPlaneOutputOptions,
  details: Record<string, unknown> | null = null,
): void {
  emitControlPlaneError(
    {
      code: CONTROL_PLANE_ERROR_CODES.modelNotBuilt,
      message,
      details,
    },
    output,
  );
}

export function emitNotImplementedError(
  message: string,
  output: ControlPlaneOutputOptions,
  details: Record<string, unknown> | null = null,
): void {
  emitControlPlaneError(
    {
      code: CONTROL_PLANE_ERROR_CODES.notImplemented,
      message,
      details,
    },
    output,
  );
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function writeJson(
  envelope: ControlPlaneJsonEnvelope<unknown>,
  output: ControlPlaneOutputOptions,
): void {
  const payload = output.prettyJson ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope);
  console.log(payload);
}

function resolveDebugEnabled(output: ControlPlaneOutputOptions): boolean {
  if (typeof output.debug === "boolean") {
    return output.debug;
  }

  const flag = resolveDebugFlagFromArgv(process.argv);
  return flag ?? false;
}

function resolveDebugFlagFromArgv(argv: string[]): boolean | undefined {
  let debugFlag: boolean | undefined;

  for (const arg of argv) {
    if (arg === "--") {
      break;
    }

    if (arg === "--debug") {
      debugFlag = true;
    }

    if (arg === "--no-debug") {
      debugFlag = false;
    }
  }

  return debugFlag;
}

function normalizeError(
  error: ControlPlaneJsonError,
  options: { debug: boolean },
): ControlPlaneJsonError {
  const details = error.details ?? null;

  if (error.code !== CONTROL_PLANE_ERROR_CODES.modelNotBuilt) {
    return {
      ...error,
      details,
    };
  }

  const normalizedMessage = MODEL_NOT_BUILT_MESSAGE;
  const normalizedHint = MODEL_NOT_BUILT_HINT;
  const originalMessage = error.message.trim();
  const shouldIncludeOriginal =
    options.debug && originalMessage.length > 0 && originalMessage !== normalizedMessage;

  return {
    ...error,
    message: normalizedMessage,
    hint: normalizedHint,
    details: shouldIncludeOriginal
      ? appendDetails(details, { original_message: originalMessage })
      : details,
  };
}

function appendDetails(
  details: Record<string, unknown> | null,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(details ?? {}),
    ...additions,
  };
}

function renderControlPlaneError(
  error: ControlPlaneJsonError,
  options: { debug: boolean },
): string {
  const lines: string[] = [error.message];

  if (error.hint) {
    lines.push(`Hint: ${error.hint}`);
  }

  if (options.debug && error.details) {
    lines.push(...formatDebugDetails(error.details));
  }

  return lines.join("\n");
}

function formatDebugDetails(details: Record<string, unknown>): string[] {
  const payload = safeJsonStringify(details);
  if (!payload) {
    return [];
  }

  if (payload.includes("\n")) {
    return ["Debug:", payload];
  }

  return [`Debug: ${payload}`];
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
