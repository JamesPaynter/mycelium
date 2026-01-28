import type { Paths } from "../../core/paths.js";
import { loadRunStateForProject } from "../../core/state-store.js";
import {
  loadCodeGraphSnapshot,
  type CodeGraphError,
  type CodeGraphSnapshot,
} from "../code-graph.js";

// =============================================================================
// TYPES
// =============================================================================

export type RunNotFoundError = {
  code: "run_not_found";
  message: string;
};

export type CodeGraphQueryError = CodeGraphError | RunNotFoundError;

export type CodeGraphQueryResult =
  | { ok: true; result: CodeGraphSnapshot }
  | { ok: false; error: CodeGraphQueryError };

// =============================================================================
// PUBLIC API
// =============================================================================

export async function queryCodeGraph(params: {
  projectName: string;
  runId: string;
  baseSha?: string | null;
  paths?: Paths;
}): Promise<CodeGraphQueryResult> {
  const resolved = await loadRunStateForProject(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return {
      ok: false,
      error: {
        code: "run_not_found",
        message: `Run ${params.runId} not found for project ${params.projectName}.`,
      },
    };
  }

  const baseSha = parseOptionalString(params.baseSha ?? null) ?? null;
  return loadCodeGraphSnapshot({ state: resolved.state, baseShaOverride: baseSha });
}

// =============================================================================
// PARAM PARSING
// =============================================================================

function parseOptionalString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
