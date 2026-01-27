// =============================================================================
// TYPES
// =============================================================================

export type CodeGraphComponent = {
  id: string;
  roots: string[];
  kind: string;
};

export type CodeGraphDependency = {
  from: string;
  to: string;
};

export type ComponentStats = {
  code_loc: number;
  code_files: number;
  unit_test_files: number;
  integration_test_files: number;
  e2e_test_files: number;
};

export type CodeGraphSnapshot = {
  base_sha: string;
  model: {
    schema_version: number | null;
    built_at: string | null;
  };
  components: CodeGraphComponent[];
  deps: CodeGraphDependency[];
  stats: Record<string, ComponentStats>;
  run_quality: {
    integration_doctor_passed: boolean | null;
  };
};

export type CodeGraphErrorCode =
  | "MODEL_NOT_FOUND"
  | "INVALID_BASE_SHA"
  | "REPO_NOT_FOUND"
  | "BASE_SHA_RESOLUTION_FAILED";

export type CodeGraphError = {
  code: CodeGraphErrorCode;
  message: string;
  hint?: string;
};

export type CodeGraphSnapshotResult =
  | { ok: true; result: CodeGraphSnapshot }
  | { ok: false; error: CodeGraphError };
