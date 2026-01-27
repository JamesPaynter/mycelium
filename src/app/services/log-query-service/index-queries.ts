import path from "node:path";

import { LogIndex, logIndexPath, type LogIndexQuery } from "../../../core/log-index.js";
import type { JsonlFilter, LogSearchResult } from "../../../core/log-query.js";

import type { LogIndexQueryResult, LogIndexSearchResult } from "./types.js";

// =============================================================================
// INDEX QUERIES
// =============================================================================

export function queryLogsFromIndex(
  runLogs: { runId: string; dir: string },
  filter: JsonlFilter,
): LogIndexQueryResult {
  const dbPath = logIndexPath(runLogs.dir);
  const indexFilter: LogIndexQuery = {};
  if (filter.taskId) indexFilter.taskId = filter.taskId;
  if (filter.typeGlob) indexFilter.typeGlob = filter.typeGlob;

  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents(indexFilter);
    return { status: "ok", lines: events.map((event) => event.raw) };
  } catch (err) {
    return {
      status: "error",
      message: `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to JSONL files.`,
    };
  } finally {
    if (index) index.close();
  }
}

export function searchLogsFromIndex(
  runLogs: { runId: string; dir: string },
  pattern: string,
  taskId?: string,
): LogIndexSearchResult {
  const dbPath = logIndexPath(runLogs.dir);
  let index: LogIndex | null = null;
  try {
    index = LogIndex.open(runLogs.runId, runLogs.dir, dbPath);
    index.ingestRunLogs(runLogs.dir);
    const events = index.queryEvents({ taskId, search: pattern });
    return {
      status: "ok",
      matches: events.map((event) => ({
        filePath: path.join(runLogs.dir, event.source),
        lineNumber: event.lineNumber,
        line: event.raw,
      })),
    };
  } catch (err) {
    return {
      status: "error",
      message: `Log index unavailable at ${dbPath} (${(err as Error).message}). Falling back to file search.`,
    };
  } finally {
    if (index) index.close();
  }
}
