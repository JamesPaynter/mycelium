import type { RunLogEvent } from "../../../core/run-logs.js";
import type { RunState } from "../../../core/state.js";

import type { TaskCounts, TimelineEntry, TimelineResult } from "./types.js";
import { durationLabel, parseDurationMs } from "./time.js";
import { compact, numberFrom, stringFrom } from "./utils.js";

// =============================================================================
// TIMELINE
// =============================================================================

type TimelineHandlerContext = {
  event: RunLogEvent;
  payload: Record<string, unknown>;
  taskId: string | null;
  attempt: number | null;
  baseDetails?: string;
  taskDurations: Map<string, number>;
  batchDurations: Map<number, number>;
};

type TimelineHandler = (context: TimelineHandlerContext) => {
  label: string;
  details?: string;
} | null;

const TIMELINE_HANDLERS: Record<string, TimelineHandler> = {
  "run.start": () => ({ label: "Run started" }),
  "run.resume": ({ payload }) => ({
    label: "Run resumed",
    details: stringFrom(payload.reason) ?? undefined,
  }),
  "run.stop": ({ payload }) => ({
    label: "Run stop requested",
    details: stringFrom(payload.reason) ?? undefined,
  }),
  "run.complete": ({ payload }) => ({
    label: `Run completed (${stringFrom(payload.status) ?? "unknown"})`,
  }),
  "batch.start": ({ payload }) => {
    const batchId = numberFrom(payload.batch_id);
    return {
      label: `Batch ${batchId ?? "?"} started`,
      details: formatTaskList(payload.tasks),
    };
  },
  "batch.merging": ({ payload }) => {
    const batchId = numberFrom(payload.batch_id);
    return {
      label: `Batch ${batchId ?? "?"} merging`,
      details: formatTaskList(payload.tasks),
    };
  },
  "batch.merge_conflict.recovered": ({ payload }) => {
    const batchId = numberFrom(payload.batch_id);
    const task = stringFrom(payload.task_id);
    const branch = stringFrom(payload.branch);
    const action = stringFrom(payload.action);
    return {
      label: `Batch ${batchId ?? "?"} merge conflict recovered`,
      details: compact([
        task ? `task ${task}` : null,
        branch ? `branch ${branch}` : null,
        action ? `action: ${action}` : null,
      ]),
    };
  },
  "batch.merge_conflict": ({ payload }) => {
    const batchId = numberFrom(payload.batch_id);
    const reason = stringFrom(payload.reason) ?? stringFrom(payload.conflict);
    return { label: `Batch ${batchId ?? "?"} merge conflict`, details: reason ?? undefined };
  },
  "batch.complete": ({ payload, batchDurations }) => {
    const batchId = numberFrom(payload.batch_id);
    const duration = batchId !== null ? batchDurations.get(batchId) : undefined;
    return {
      label: `Batch ${batchId ?? "?"} complete`,
      details: compact([durationLabel(duration)]),
    };
  },
  "worker.start": ({ taskId }) => ({ label: `Task ${taskId ?? "?"} worker started` }),
  "turn.start": ({ taskId, baseDetails }) => ({
    label: `Task ${taskId ?? "?"} Codex turn start`,
    details: baseDetails,
  }),
  "turn.complete": ({ taskId, baseDetails }) => ({
    label: `Task ${taskId ?? "?"} Codex turn complete`,
    details: baseDetails,
  }),
  "task.retry": ({ taskId, baseDetails }) => ({
    label: `Task ${taskId ?? "?"} retry`,
    details: baseDetails,
  }),
  "doctor.start": ({ taskId, baseDetails }) => ({
    label: `Task ${taskId ?? "?"} doctor start`,
    details: baseDetails,
  }),
  "doctor.pass": ({ taskId, baseDetails }) => ({
    label: `Task ${taskId ?? "?"} doctor passed`,
    details: baseDetails,
  }),
  "doctor.fail": ({ payload, taskId, baseDetails }) => {
    const exitCode = numberFrom(payload.exit_code);
    const summary = stringFrom(payload.summary);
    return {
      label: `Task ${taskId ?? "?"} doctor failed`,
      details: compact([baseDetails, exitCode !== null ? `exit ${exitCode}` : null, summary]),
    };
  },
  "task.complete": ({ payload, taskId, taskDurations }) => {
    const duration = taskId ? taskDurations.get(taskId) : undefined;
    const attempts = numberFrom(payload.attempts);
    return {
      label: `Task ${taskId ?? "?"} complete`,
      details: compact([attempts ? `${attempts} attempt(s)` : null, durationLabel(duration)]),
    };
  },
  "task.failed": ({ payload, taskId, taskDurations }) => {
    const duration = taskId ? taskDurations.get(taskId) : undefined;
    const attempts = numberFrom(payload.attempts);
    const message = stringFrom(payload.message);
    return {
      label: `Task ${taskId ?? "?"} failed`,
      details: compact([
        attempts ? `${attempts} attempt(s)` : null,
        durationLabel(duration),
        message,
      ]),
    };
  },
  "task.rescope.start": buildRescopeTimelineEntry,
  "task.rescope.updated": buildRescopeTimelineEntry,
  "task.rescope.failed": buildRescopeTimelineEntry,
  "validator.fail": buildValidatorTimelineEntry,
  "validator.error": buildValidatorTimelineEntry,
  "validator.block": buildValidatorTimelineEntry,
};

export function buildTimeline(events: RunLogEvent[], state: RunState | null): TimelineResult {
  const entries: TimelineEntry[] = [];
  const taskDurations = state ? buildTaskDurations(state) : new Map<string, number>();
  const batchDurations = state ? buildBatchDurations(state) : new Map<number, number>();

  for (const event of events) {
    const described = describeTimelineEvent(event, taskDurations, batchDurations);
    if (described) {
      entries.push({ ts: event.ts, ...described });
    }
  }

  const runDurationMs =
    state?.started_at && state?.updated_at
      ? (parseDurationMs(state.started_at, state.updated_at) ?? undefined)
      : (parseDurationMs(events[0]?.ts, events[events.length - 1]?.ts) ?? undefined);

  const taskCounts = state ? buildTaskCounts(state) : null;
  return { entries, runDurationMs, taskCounts };
}

function describeTimelineEvent(
  event: RunLogEvent,
  taskDurations: Map<string, number>,
  batchDurations: Map<number, number>,
): { label: string; details?: string } | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const attempt = event.attempt ?? numberFrom(payload.attempt);
  const taskId = event.taskId ?? stringFrom(payload.task_id);
  const baseDetails = attemptDetail(attempt);

  const handler = TIMELINE_HANDLERS[event.type];
  if (!handler) return null;

  return handler({
    event,
    payload,
    taskId,
    attempt,
    baseDetails,
    taskDurations,
    batchDurations,
  });
}

function buildTaskCounts(state: RunState): TaskCounts {
  const counts: TaskCounts = {
    total: Object.keys(state.tasks).length,
    pending: 0,
    running: 0,
    validated: 0,
    complete: 0,
    failed: 0,
    needs_human_review: 0,
    needs_rescope: 0,
    rescope_required: 0,
    skipped: 0,
  };

  for (const task of Object.values(state.tasks)) {
    counts[task.status] += 1;
  }

  return counts;
}

function buildTaskDurations(state: RunState): Map<string, number> {
  const durations = new Map<string, number>();
  for (const [taskId, task] of Object.entries(state.tasks)) {
    const duration = parseDurationMs(task.started_at, task.completed_at);
    if (duration !== null) {
      durations.set(taskId, duration);
    }
  }
  return durations;
}

function buildBatchDurations(state: RunState): Map<number, number> {
  const durations = new Map<number, number>();
  for (const batch of state.batches) {
    const duration = parseDurationMs(batch.started_at, batch.completed_at);
    if (duration !== null) {
      durations.set(batch.batch_id, duration);
    }
  }
  return durations;
}

function buildRescopeTimelineEntry(context: TimelineHandlerContext): {
  label: string;
  details?: string;
} {
  const reason = stringFrom(context.payload.reason);
  return {
    label: `Task ${context.taskId ?? "?"} ${context.event.type
      .replace("task.", "")
      .replace(".", " ")}`,
    details: compact([context.baseDetails, reason]),
  };
}

function buildValidatorTimelineEntry(context: TimelineHandlerContext): {
  label: string;
  details?: string;
} {
  const validator = stringFrom(context.payload.validator) ?? "validator";
  const suffix = context.event.type.split(".")[1] ?? context.event.type;
  return {
    label: `Validator ${validator} ${suffix}`,
    details: context.taskId ? `task ${context.taskId}` : undefined,
  };
}

function attemptDetail(attempt?: number | null): string | undefined {
  if (attempt === undefined || attempt === null) return undefined;
  return `attempt ${attempt}`;
}

function formatTaskList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((item) => stringFrom(item))
    .filter(Boolean)
    .map((item) => String(item));
  if (names.length === 0) return undefined;
  return `tasks: ${names.join(", ")}`;
}
