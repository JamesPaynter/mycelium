import { normalizeWriteGlobs } from "./loop-parsing.js";
import type { TaskManifest } from "./loop.js";

// =============================================================================
// PROMPTS
// =============================================================================

export function buildInitialPrompt(args: {
  spec: string;
  manifest: TaskManifest;
  manifestPath: string;
  taskBranch?: string;
  lastAttemptSummary?: string | null;
  declaredWriteGlobs?: string[];
  strictTddContext?: {
    stage: "tests" | "implementation";
    testPaths: string[];
    fastFailureOutput?: string;
  };
}): string {
  const manifestJson = JSON.stringify(args.manifest, null, 2);
  const branchLine = args.taskBranch ? `Task branch: ${args.taskBranch}` : null;
  const lastAttemptSection = args.lastAttemptSummary
    ? `Last attempt summary:\n${args.lastAttemptSummary}`
    : null;
  const writeScopeSection = buildWriteScopeSection(
    args.declaredWriteGlobs ?? args.manifest.files?.writes ?? [],
  );
  const stageContext =
    args.strictTddContext?.stage === "tests"
      ? [
          "Strict TDD Stage A (tests-only): add failing tests first.",
          args.strictTddContext.testPaths.length > 0
            ? `Limit edits to tests matching:\n- ${args.strictTddContext.testPaths.join("\n- ")}`
            : undefined,
          "Do not modify production code until Stage B.",
        ]
          .filter(Boolean)
          .join("\n")
      : args.strictTddContext?.stage === "implementation" && args.strictTddContext.fastFailureOutput
        ? [
            "Strict TDD Stage B: tests are already failing from Stage A.",
            "Keep the test changes stable and implement code to make them pass.",
            `verify.fast output (truncated):\n${args.strictTddContext.fastFailureOutput}`,
          ].join("\n\n")
        : args.strictTddContext?.stage === "implementation"
          ? "Strict TDD Stage B: tests already exist; focus on implementation until the doctor command passes."
          : null;

  const rules = [
    "Rules:",
    "- Prefer test-driven development: add/adjust tests first, confirm they fail for the right reason, then implement.",
    "- Keep changes minimal and aligned with existing patterns.",
    "- Run the provided verification commands in the spec and ensure the doctor command passes.",
    "- If doctor fails, iterate until it passes.",
  ];

  const repoNavigation = [
    "Repo navigation tools (use before grepping):",
    "Prefer `mycelium cg` for ownership, dependencies, blast radius, and symbol navigation.",
    "- mycelium cg components list",
    "- mycelium cg owner <path>",
    "- mycelium cg blast <path>",
    "- mycelium cg symbols find <query>",
    "- mycelium cg symbols def <symbol>",
    "- mycelium cg symbols refs <symbol>",
  ].join("\n");

  if (args.strictTddContext?.stage === "tests") {
    rules.unshift("- Stage A: edit tests only; production code changes are not allowed yet.");
  }
  if (args.strictTddContext?.stage === "implementation") {
    rules.unshift("- Stage B: keep existing tests intact and implement code to satisfy them.");
  }

  const sections = [
    "You are a coding agent working in a git repository.",
    `Task manifest (${args.manifestPath}):\n${manifestJson}`,
    branchLine,
    stageContext,
    lastAttemptSection,
    writeScopeSection,
    `Task spec:\n${args.spec.trim()}`,
    repoNavigation,
    rules.join("\n"),
  ];

  return sections.filter((part) => Boolean(part)).join("\n\n");
}

export function buildRetryPrompt(args: {
  spec: string;
  lastFailure: { type: "lint" | "doctor" | "codex" | "command"; output: string };
  failedAttempt: number;
  lastAttemptSummary?: string | null;
  declaredWriteGlobs?: string[];
}): string {
  const failureOutput = args.lastFailure.output.trim();
  const outputLabel =
    args.lastFailure.type === "lint"
      ? "Lint output:"
      : args.lastFailure.type === "doctor"
        ? "Doctor output:"
        : args.lastFailure.type === "codex"
          ? "Codex error:"
          : "Command error:";
  const failureLabel =
    args.lastFailure.type === "lint"
      ? "lint command"
      : args.lastFailure.type === "doctor"
        ? "doctor command"
        : args.lastFailure.type === "codex"
          ? "Codex run"
          : "command";
  const outputText =
    failureOutput.length > 0 ? failureOutput : `<no ${args.lastFailure.type} output captured>`;
  const guidance = (() => {
    if (args.lastFailure.type === "lint") {
      return "Fix the lint issues. Then re-run lint and doctor until they pass.";
    }
    if (args.lastFailure.type === "doctor") {
      return "Re-read the task spec and fix the issues. Then re-run doctor until it passes.";
    }
    if (args.lastFailure.type === "codex") {
      return "Retry the task with smaller, safer steps. If the Codex error repeats, reduce scope or clarify the change.";
    }
    return "The command failed to run. Fix the environment or command and retry.";
  })();

  const lastAttemptSection = args.lastAttemptSummary
    ? `Last attempt summary:\n${args.lastAttemptSummary}`
    : null;
  const writeScopeSection = buildWriteScopeSection(args.declaredWriteGlobs ?? []);

  return [
    `The ${failureLabel} failed on attempt ${args.failedAttempt}.`,
    lastAttemptSection ?? "",
    writeScopeSection ?? "",
    "",
    outputLabel,
    outputText,
    "",
    guidance,
    "",
    "Task spec:",
    args.spec.trim(),
  ].join("\n");
}

export function buildWriteScopeSection(globs: string[]): string {
  const normalized = normalizeWriteGlobs(globs);
  const scopeLines = [
    "Declared write scope (manifest files.writes):",
    normalized.length > 0 ? `- ${normalized.join("\n- ")}` : "- <none declared>",
    "If you must touch files outside this set, proceed but explicitly report the divergence (list files + why). Do not abort.",
  ];
  return scopeLines.join("\n");
}
