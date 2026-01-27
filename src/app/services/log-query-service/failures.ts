import { readDoctorLogSnippet, type RunLogEvent } from "../../../core/run-logs.js";

import type { FailureExample, FailureGroup } from "./types.js";
import { compact, numberFrom, stringFrom } from "./utils.js";

// =============================================================================
// FAILURE GROUPS
// =============================================================================

type FailureHandlerContext = {
  event: RunLogEvent;
  payload: Record<string, unknown>;
  taskId: string | null;
  attempt: number | null;
  baseExample: FailureExample;
  runLogsDir: string;
};

type FailureHandler = (context: FailureHandlerContext) => {
  key: string;
  label: string;
  example: FailureExample;
} | null;

const FAILURE_HANDLERS: Record<string, FailureHandler> = {
  "task.failed": ({ payload, baseExample }) => {
    const message =
      stringFrom(payload.message) ?? "Task worker exited with a non-zero status or error.";
    return {
      key: "task.failed",
      label: "Task failures",
      example: { ...baseExample, message },
    };
  },
  "task.rescope.failed": ({ payload, baseExample }) => {
    const message = stringFrom(payload.reason) ?? "Rescope failed";
    return {
      key: "task.rescope.failed",
      label: "Rescope failures",
      example: { ...baseExample, message },
    };
  },
  "doctor.fail": ({ payload, baseExample, runLogsDir, taskId }) => {
    const exitCode = numberFrom(payload.exit_code);
    const summary = stringFrom(payload.summary);
    const message = compact([
      summary ?? "Doctor command failed",
      exitCode !== null ? `exit ${exitCode}` : null,
    ]);
    const snippet = pickDoctorSnippet(runLogsDir, taskId, baseExample.attempt);
    return {
      key: "doctor.fail",
      label: "Doctor failures",
      example: {
        ...baseExample,
        message: message ?? "Doctor command failed",
        snippet,
      },
    };
  },
  "doctor.canary.unexpected_pass": ({ payload, baseExample }) => {
    const severity = stringFrom(payload.severity) ?? "warn";
    if (severity === "warn" || severity === "warning") {
      return null;
    }
    const message =
      stringFrom(payload.message) ?? stringFrom(payload.reason) ?? "Doctor canary unexpected pass";
    return {
      key: "doctor.canary.unexpected_pass",
      label: "Doctor canary unexpected passes",
      example: { ...baseExample, message },
    };
  },
  "validator.fail": buildValidatorFailure,
  "validator.error": buildValidatorFailure,
  "validator.block": buildValidatorFailure,
  "batch.merge_conflict": ({ payload, baseExample }) => {
    const message = stringFrom(payload.reason) ?? "Merge conflict detected";
    return {
      key: "batch.merge_conflict",
      label: "Merge conflicts",
      example: { ...baseExample, message },
    };
  },
  "batch.merge_conflict.recovered": ({ payload, baseExample }) => {
    const message = stringFrom(payload.message) ?? "Merge conflict recovered";
    return {
      key: "batch.merge_conflict.recovered",
      label: "Merge conflicts recovered",
      example: { ...baseExample, message },
    };
  },
  "run.stop": ({ payload, baseExample }) => {
    const reason = stringFrom(payload.reason) ?? "Run stopped";
    return {
      key: `run.stop.${reason}`,
      label: "Run stops",
      example: { ...baseExample, message: reason },
    };
  },
  "worker.local.error": ({ payload, baseExample }) => {
    const message = stringFrom(payload.message) ?? "Worker error";
    return {
      key: "worker.local.error",
      label: "Worker errors",
      example: { ...baseExample, message },
    };
  },
  "container.exit": ({ payload, baseExample }) => {
    const exitCode = numberFrom(payload.exit_code);
    if (exitCode === null || exitCode === 0) return null;
    return {
      key: "container.exit",
      label: "Container exits",
      example: { ...baseExample, message: `Container exit code ${exitCode}` },
    };
  },
  "budget.block": ({ payload, baseExample }) => {
    const scope = stringFrom(payload.scope);
    const message = scope ? `Budget block (${scope})` : "Budget block";
    return {
      key: "budget.block",
      label: "Budget blocks",
      example: { ...baseExample, message },
    };
  },
  "manifest.compliance.block": ({ payload, baseExample }) => {
    const reason = stringFrom(payload.reason) ?? "Manifest enforcement blocked";
    return {
      key: "manifest.compliance.block",
      label: "Manifest blocks",
      example: { ...baseExample, message: reason },
    };
  },
};

export function buildFailureGroups(events: RunLogEvent[], runLogsDir: string): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const event of events) {
    const failure = classifyFailure(event, runLogsDir);
    if (!failure) continue;

    const current = groups.get(failure.key);
    if (!current) {
      groups.set(failure.key, {
        key: failure.key,
        label: failure.label,
        count: 1,
        examples: [failure.example],
      });
    } else {
      current.count += 1;
      if (current.examples.length < 3) {
        current.examples.push(failure.example);
      }
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

function classifyFailure(
  event: RunLogEvent,
  runLogsDir: string,
): { key: string; label: string; example: FailureExample } | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const taskId = event.taskId ?? stringFrom(payload.task_id);
  const baseExample: FailureExample = {
    ts: event.ts,
    taskId: taskId ?? null,
    attempt: event.attempt ?? numberFrom(payload.attempt),
    message: "",
    source: event.source,
  };

  const handler = FAILURE_HANDLERS[event.type];
  if (!handler) return null;

  return handler({
    event,
    payload,
    taskId,
    attempt: baseExample.attempt,
    baseExample,
    runLogsDir,
  });
}

function buildValidatorFailure(context: FailureHandlerContext): {
  key: string;
  label: string;
  example: FailureExample;
} {
  const validator = stringFrom(context.payload.validator) ?? "validator";
  const suffix = context.event.type.split(".")[1] ?? context.event.type;
  const key = `validator.${suffix}.${validator}`;
  const message =
    stringFrom(context.payload.message) ??
    stringFrom(context.payload.reason) ??
    `${validator} ${suffix}`.trim();
  return {
    key,
    label: `Validator ${validator} ${suffix}`,
    example: { ...context.baseExample, message },
  };
}

function pickDoctorSnippet(
  runLogsDir: string,
  taskId: string | null,
  attempt?: number | null,
): string | null {
  if (!taskId) return null;
  const snippet = readDoctorLogSnippet(runLogsDir, taskId, attempt ?? null);
  return snippet ? snippet.content.replace(/\s+/g, " ").trim() : null;
}
