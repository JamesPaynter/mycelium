export const CONTROL_PLANE_ERROR_CODES = {
  modelNotBuilt: "MODEL_NOT_BUILT",
  notImplemented: "NOT_IMPLEMENTED",
  modelStoreError: "MODEL_STORE_ERROR",
  symbolRefsUnavailable: "SYMBOL_REFS_UNAVAILABLE",
} as const;

export type ControlPlaneErrorCode =
  (typeof CONTROL_PLANE_ERROR_CODES)[keyof typeof CONTROL_PLANE_ERROR_CODES];



// =============================================================================
// JSON SHAPES
// =============================================================================

export type ControlPlaneJsonError = {
  code: ControlPlaneErrorCode;
  message: string;
  details: Record<string, unknown> | null;
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
  const normalized = normalizeError(error);

  if (output.useJson) {
    writeJson({ ok: false, error: normalized }, output);
  } else {
    console.error(normalized.message);
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
  const payload = output.prettyJson
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  console.log(payload);
}

function normalizeError(error: ControlPlaneJsonError): ControlPlaneJsonError {
  return {
    ...error,
    details: error.details ?? null,
  };
}
