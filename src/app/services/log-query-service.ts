/*
Purpose: App-layer helpers for querying run logs, building timelines, and summarizing validator output.
Key assumptions: Run log directories follow core/paths and core/log-query conventions; CLI handles output and exit codes.
Usage: Instantiate LogQueryService with config for index queries and LLM summaries; use buildTimeline/buildFailureGroups for reporting.
*/

import type { ProjectConfig } from "../../core/config.js";
import type { JsonlFilter } from "../../core/log-query.js";
import type { RunLogEvent } from "../../core/run-logs.js";
import type { RunState, TaskState } from "../../core/state.js";

import { buildFailureGroups } from "./log-query-service/failures.js";
import { queryLogsFromIndex, searchLogsFromIndex } from "./log-query-service/index-queries.js";
import {
  buildStatusLine,
  collectValidatorSummaries,
  findLastAttempt,
  findLastCodexTurn,
  runLlmSummary,
  suggestNextAction,
} from "./log-query-service/summary.js";
import { formatDuration, formatTimestamp } from "./log-query-service/time.js";
import { buildTimeline } from "./log-query-service/timeline.js";
import type {
  CodexTurnInfo,
  FailureGroup,
  LlmSummaryResult,
  LogIndexQueryResult,
  LogIndexSearchResult,
  LogSummaryInput,
  TimelineResult,
  ValidatorSummaryRow,
} from "./log-query-service/types.js";
import { pickDoctorLog, relativeToRun } from "./log-query-service/utils.js";

export type {
  CodexTurnInfo,
  FailureGroup,
  LlmSummaryResult,
  LogIndexQueryResult,
  LogIndexSearchResult,
  LogSummaryInput,
  TimelineEntry,
  TimelineResult,
  TaskCounts,
  ValidatorSummaryRow,
} from "./log-query-service/types.js";

export {
  buildFailureGroups,
  buildTimeline,
  formatDuration,
  formatTimestamp,
  pickDoctorLog,
  relativeToRun,
};

// =============================================================================
// SERVICE
// =============================================================================

export class LogQueryService {
  private readonly config: ProjectConfig;

  constructor(config: ProjectConfig) {
    this.config = config;
  }

  queryLogsFromIndex(
    runLogs: { runId: string; dir: string },
    filter: JsonlFilter,
  ): LogIndexQueryResult {
    return queryLogsFromIndex(runLogs, filter);
  }

  searchLogsFromIndex(
    runLogs: { runId: string; dir: string },
    pattern: string,
    taskId?: string,
  ): LogIndexSearchResult {
    return searchLogsFromIndex(runLogs, pattern, taskId);
  }

  buildTimeline(events: RunLogEvent[], state: RunState | null): TimelineResult {
    return buildTimeline(events, state);
  }

  buildFailureGroups(events: RunLogEvent[], runLogsDir: string): FailureGroup[] {
    return buildFailureGroups(events, runLogsDir);
  }

  collectValidatorSummaries(
    runLogsDir: string,
    taskId: string,
    taskState?: TaskState | null,
  ): Promise<ValidatorSummaryRow[]> {
    return collectValidatorSummaries(runLogsDir, taskId, taskState);
  }

  buildStatusLine(taskState?: TaskState | null): string {
    return buildStatusLine(taskState);
  }

  findLastAttempt(
    events: RunLogEvent[],
    predicate: (event: RunLogEvent) => boolean,
  ): number | null {
    return findLastAttempt(events, predicate);
  }

  findLastCodexTurn(events: RunLogEvent[]): CodexTurnInfo | null {
    return findLastCodexTurn(events);
  }

  suggestNextAction(
    taskState: TaskState | null,
    validators: ValidatorSummaryRow[],
    doctorLog: { content: string } | null,
    codexTurn: CodexTurnInfo | null,
  ): string {
    return suggestNextAction(taskState, validators, doctorLog, codexTurn);
  }

  runLlmSummary(input: LogSummaryInput): Promise<LlmSummaryResult> {
    return runLlmSummary(this.config, input);
  }

  formatTimestamp(ts: string): string {
    return formatTimestamp(ts);
  }

  formatDuration(ms?: number | null): string {
    return formatDuration(ms);
  }

  relativeToRun(baseDir: string, targetPath: string): string {
    return relativeToRun(baseDir, targetPath);
  }

  pickDoctorLog(files: string[], attempt?: number): { attempt: number; fileName: string } | null {
    return pickDoctorLog(files, attempt);
  }
}
