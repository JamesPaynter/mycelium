import type { Paths } from "../../core/paths.js";
import { listRunHistoryEntries, type RunHistoryEntry } from "../../core/run-history.js";
import {
  loadRunStateForProject,
  summarizeRunState,
  type RunStatusSummary,
} from "../../core/state-store.js";

// =============================================================================
// TYPES
// =============================================================================

export type RunQueryError = {
  code: "bad_request" | "not_found";
  message: string;
};

export type RunQueryResult<T> = { ok: true; result: T } | { ok: false; error: RunQueryError };

export type RunsListResult = {
  runs: RunHistoryEntry[];
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function queryRunsList(params: {
  projectName: string;
  limit?: string | null;
  paths?: Paths;
}): Promise<RunQueryResult<RunsListResult>> {
  const limitResult = parseOptionalPositiveInteger(params.limit ?? null);
  if (!limitResult.ok) {
    return { ok: false, error: { code: "bad_request", message: "Invalid limit value." } };
  }

  const runs = await listRunHistoryEntries(
    params.projectName,
    {
      limit: limitResult.value ?? undefined,
    },
    params.paths,
  );

  return { ok: true, result: { runs } };
}

export async function queryRunSummary(params: {
  projectName: string;
  runId: string;
  paths?: Paths;
}): Promise<RunQueryResult<RunStatusSummary>> {
  const resolved = await loadRunStateForProject(params.projectName, params.runId, params.paths);
  if (!resolved) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `Run ${params.runId} not found for project ${params.projectName}.`,
      },
    };
  }

  const summary = summarizeRunState(resolved.state);
  return { ok: true, result: summary };
}

// =============================================================================
// PARAM PARSING
// =============================================================================

type OptionalNumberParseResult = { ok: true; value: number | null } | { ok: false };

function parseOptionalNonNegativeInteger(value: string | null): OptionalNumberParseResult {
  if (value === null) {
    return { ok: true, value: null };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }

  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false };
  }

  return { ok: true, value: parsed };
}

function parseOptionalPositiveInteger(value: string | null): OptionalNumberParseResult {
  const parsed = parseOptionalNonNegativeInteger(value);
  if (!parsed.ok) {
    return { ok: false };
  }

  if (parsed.value === null) {
    return parsed;
  }

  return parsed.value > 0 ? parsed : { ok: false };
}
