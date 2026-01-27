import type { LogSearchResult } from "../../../core/log-query.js";

// =============================================================================
// TYPES
// =============================================================================

export type ValidatorSummaryRow = {
  validator: string;
  status: string;
  summary: string | null;
  reportPath: string | null;
};

export type TimelineEntry = {
  ts: string;
  label: string;
  details?: string;
};

export type TimelineResult = {
  entries: TimelineEntry[];
  runDurationMs?: number;
  taskCounts?: TaskCounts | null;
};

export type TaskCounts = {
  total: number;
  pending: number;
  running: number;
  validated: number;
  complete: number;
  failed: number;
  needs_human_review: number;
  needs_rescope: number;
  rescope_required: number;
  skipped: number;
};

export type FailureExample = {
  ts: string;
  taskId: string | null;
  attempt: number | null;
  message: string;
  source: string;
  snippet?: string | null;
};

export type FailureGroup = {
  key: string;
  label: string;
  count: number;
  examples: FailureExample[];
};

export type CodexTurnInfo = {
  attempt: number | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number | null;
};

export type LogSummaryInput = {
  runId: string;
  taskId: string;
  statusLine: string;
  attempts: number | null;
  lastError: string | null;
  doctorText: string | null;
  codex: CodexTurnInfo | null;
  validators: ValidatorSummaryRow[];
  nextAction: string;
};

export type LogIndexQueryResult =
  | { status: "ok"; lines: string[] }
  | { status: "error"; message: string };

export type LogIndexSearchResult =
  | { status: "ok"; matches: LogSearchResult[] }
  | { status: "error"; message: string };

export type LlmSummaryResult =
  | { status: "ok"; text: string }
  | { status: "disabled"; message: string }
  | { status: "error"; message: string };
