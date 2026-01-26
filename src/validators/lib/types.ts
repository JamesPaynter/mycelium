// Validators shared types.
// Purpose: define common data shapes for validator inputs and persisted reports.
// Assumes validator reports are serialized as JSON with stable field names.


// =============================================================================
// TYPES
// =============================================================================

export type FileSample = {
  path: string;
  content: string;
  truncated: boolean;
};

export type TruncateResult = {
  text: string;
  truncated: boolean;
};

export type TaskValidatorReport<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = {
  task_id: string;
  task_name: string;
  task_slug: string;
  validator: string;
  run_id: string;
  result: TResult;
  meta: TMeta;
};

export type RunValidatorReport<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = {
  project: string;
  run_id: string;
  validator: string;
  trigger: string;
  result: TResult;
  meta: TMeta;
};
