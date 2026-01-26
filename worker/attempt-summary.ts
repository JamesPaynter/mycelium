import fs from "node:fs/promises";
import path from "node:path";

import { minimatch } from "minimatch";

import { isoNow, safeAttemptName, writeRunLog } from "./logging.js";

// =============================================================================
// TYPES
// =============================================================================

export type AttemptPhase = "tdd_stage_a" | "implementation";
export type PromptKind = "initial" | "retry";

export type RetryReason = {
  reason_code: string;
  human_readable_reason: string;
  evidence_paths: string[];
};

export type CommandSummary = {
  command: string;
  exit_code: number;
  output_preview?: string;
  log_path?: string;
};

export type BootstrapCommandSummary = CommandSummary & { index: number };

export type AttemptSummary = {
  attempt: number;
  phase: AttemptPhase;
  timestamp: string;
  prompt_kind: PromptKind;
  changed_files: string[];
  scope_divergence?: {
    declared_write_globs: string[];
    out_of_scope_files: string[];
  };
  tdd?: {
    non_test_changes_detected?: string[];
    fast_exit_code?: number;
    fast_output_preview?: string;
  };
  commands?: {
    bootstrap?: BootstrapCommandSummary[];
    lint?: CommandSummary;
    doctor?: CommandSummary;
  };
  retry?: RetryReason;
};

export type AttemptSummaryInput = {
  attempt: number;
  phase: AttemptPhase;
  prompt_kind: PromptKind;
  changed_files: string[];
  declared_write_globs: string[];
  tdd?: AttemptSummary["tdd"];
  commands?: AttemptSummary["commands"];
  retry?: RetryReason;
  timestamp?: string;
};

// =============================================================================
// SUMMARY BUILDING
// =============================================================================

export function buildAttemptSummary(input: AttemptSummaryInput): AttemptSummary {
  const declaredWriteGlobs = normalizeGlobs(input.declared_write_globs);
  const changedFiles = normalizeFiles(input.changed_files);
  const outOfScope = declaredWriteGlobs.length
    ? changedFiles.filter(
        (file) =>
          !declaredWriteGlobs.some((pattern) =>
            minimatch(file, toPosixPath(pattern), { dot: true, nocase: false }),
          ),
      )
    : [];

  const scopeDivergence =
    declaredWriteGlobs.length > 0
      ? {
          declared_write_globs: declaredWriteGlobs,
          out_of_scope_files: outOfScope,
        }
      : undefined;

  return {
    attempt: input.attempt,
    phase: input.phase,
    timestamp: input.timestamp ?? isoNow(),
    prompt_kind: input.prompt_kind,
    changed_files: changedFiles,
    scope_divergence: scopeDivergence,
    tdd: input.tdd,
    commands: input.commands,
    retry: input.retry,
  };
}

export function formatAttemptSummaryForPrompt(summary: AttemptSummary): string {
  const lines: string[] = [];

  const phaseLabel = summary.phase.replace(/_/g, " ");
  lines.push(`Attempt ${summary.attempt} (${phaseLabel}, ${summary.prompt_kind}).`);

  if (summary.retry) {
    lines.push(`Retry reason: ${summary.retry.reason_code} — ${summary.retry.human_readable_reason}`);
  } else {
    lines.push("Result: completed this phase.");
  }

  const nonTest = summary.tdd?.non_test_changes_detected ?? [];
  if (nonTest.length > 0) {
    lines.push(`Non-test changes: ${formatList(nonTest)}`);
  }

  if (summary.tdd?.fast_exit_code !== undefined) {
    lines.push(`verify.fast exit: ${summary.tdd.fast_exit_code}`);
  }

  const outOfScope = summary.scope_divergence?.out_of_scope_files ?? [];
  if (outOfScope.length > 0) {
    lines.push(`Scope divergence: ${formatList(outOfScope)}`);
  }

  if (summary.changed_files.length > 0) {
    lines.push(`Changed files: ${formatList(summary.changed_files)}`);
  }

  return lines.join("\n");
}

// =============================================================================
// PERSISTENCE
// =============================================================================

export async function persistAttemptSummary(
  runLogsDir: string,
  summary: AttemptSummary,
): Promise<{ summaryPath: string; promptSummary: string }> {
  const fileName = `attempt-${safeAttemptName(summary.attempt)}.summary.json`;
  const content = JSON.stringify(summary, null, 2) + "\n";
  writeRunLog(runLogsDir, fileName, content);

  await updateSummaryMarkdown(runLogsDir, summary);

  return {
    summaryPath: path.join(runLogsDir, fileName),
    promptSummary: formatAttemptSummaryForPrompt(summary),
  };
}

async function updateSummaryMarkdown(runLogsDir: string, summary: AttemptSummary): Promise<void> {
  const filePath = path.join(runLogsDir, "attempts.summary.md");
  const header = "# Attempt summaries\n\n";
  const line = `- Attempt ${summary.attempt} (${summary.phase}, ${summary.prompt_kind}): ${formatSummaryLine(
    summary,
  )}\n`;

  try {
    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    const prefix = existing.trim().length > 0 ? existing.trimEnd() + "\n" : header;
    await fs.mkdir(runLogsDir, { recursive: true });
    await fs.writeFile(filePath, `${prefix}${line}`, "utf8");
  } catch {
    // Best-effort; summary persistence should not stop the worker.
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function formatSummaryLine(summary: AttemptSummary): string {
  if (summary.retry) {
    const outOfScope = summary.scope_divergence?.out_of_scope_files ?? [];
    const changedPreview = summary.changed_files.length > 0 ? `; changed: ${formatList(summary.changed_files)}` : "";
    const scopePreview = outOfScope.length > 0 ? `; scope drift: ${formatList(outOfScope)}` : "";
    return `${summary.retry.reason_code}${changedPreview}${scopePreview}`;
  }
  return "completed";
}

function formatList(items: string[], limit = 6): string {
  if (items.length === 0) return "";
  const visible = items.slice(0, limit).join(", ");
  const remaining = items.length - limit;
  return remaining > 0 ? `${visible} (+${remaining} more)` : visible;
}

function normalizeFiles(files: string[]): string[] {
  const normalized = files.map((file) => toPosixPath(file.trim())).filter((file) => file.length > 0);
  return Array.from(new Set(normalized)).sort();
}

function normalizeGlobs(globs: string[]): string[] {
  const normalized = globs.map((glob) => glob.trim()).filter((glob) => glob.length > 0);
  return Array.from(new Set(normalized)).sort();
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}
