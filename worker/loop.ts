import fs from "node:fs/promises";
import path from "node:path";

import { execa, execaCommand } from "execa";

import { isTestPath, resolveTestPaths } from "../src/core/test-paths.js";
import {
  buildAttemptSummary,
  persistAttemptSummary,
  type AttemptPhase,
  type AttemptSummary,
  type BootstrapCommandSummary,
  type CommandSummary,
  type PromptKind,
  type RetryReason,
} from "./attempt-summary.js";
import { createCodexRunner, type CodexRunnerLike } from "./codex.js";
import {
  createStdoutLogger,
  safeAttemptName,
  toErrorMessage,
  writeRunLog,
  type JsonObject,
  type WorkerLogger,
} from "./logging.js";
import { WorkerStateStore } from "./state.js";

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

export type TaskManifest = {
  id: string;
  name: string;
  files?: { writes?: string[] };
  verify?: { doctor?: string; fast?: string; lint?: string };
  tdd_mode?: "off" | "strict";
  test_paths?: string[];
  affected_tests?: string[];
  [key: string]: unknown;
};

export type WorkerConfig = {
  taskId: string;
  taskSlug?: string;
  taskBranch?: string;
  specPath: string;
  manifestPath: string;
  lintCmd?: string;
  lintTimeoutSeconds?: number;
  doctorCmd: string;
  doctorTimeoutSeconds?: number;
  maxRetries: number;
  bootstrapCmds: string[];
  runLogsDir: string;
  codexHome: string;
  codexModel?: string;
  workingDirectory: string;
  checkpointCommits: boolean;
  defaultTestPaths?: string[];
  logCodexPrompts?: boolean;
};

const DOCTOR_PROMPT_LIMIT = 12_000;
const OUTPUT_PREVIEW_LIMIT = 4_000;
const PROMPT_PREVIEW_LIMIT = 4_000;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runWorker(config: WorkerConfig, logger?: WorkerLogger): Promise<void> {
  const log = logger ?? createStdoutLogger({ taskId: config.taskId, taskSlug: config.taskSlug });
  const logCodexPrompts = config.logCodexPrompts === true;

  if (config.maxRetries < 0) {
    throw new Error(`maxRetries must be non-negative (received ${config.maxRetries})`);
  }

  const { spec, manifest } = await loadTaskInputs(config.specPath, config.manifestPath);
  const workerFailOnceFile = path.join(config.codexHome, ".fail-once");
  const commandEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TASK_ID: config.taskId,
    TASK_SLUG: config.taskSlug,
    TASK_BRANCH: config.taskBranch,
    CODEX_HOME: config.codexHome,
    RUN_LOGS_DIR: config.runLogsDir,
    WORKER_FAIL_ONCE_FILE: workerFailOnceFile,
    LOG_CODEX_PROMPTS: logCodexPrompts ? "1" : "0",
  };
  if (config.codexModel) {
    commandEnv.CODEX_MODEL = config.codexModel;
  }
  const workerPayload: JsonObject = {
    manifest_path: config.manifestPath,
    spec_path: config.specPath,
    bootstrap_cmds: config.bootstrapCmds.length,
    max_retries: config.maxRetries,
  };
  if (config.taskBranch) {
    workerPayload.branch = config.taskBranch;
  }
  log.log({ type: "worker.start", payload: workerPayload });

  await ensureGitIdentity(config.workingDirectory, log);

  const bootstrapResults =
    config.bootstrapCmds.length > 0
      ? await runBootstrap({
          commands: config.bootstrapCmds,
          cwd: config.workingDirectory,
          log,
          runLogsDir: config.runLogsDir,
          env: commandEnv,
        })
      : [];

  await fs.mkdir(config.codexHome, { recursive: true });

  const workerState = new WorkerStateStore(config.workingDirectory);
  await workerState.load();

  const retryLimit = config.maxRetries === 0 ? Number.POSITIVE_INFINITY : config.maxRetries;
  const hasRetryLimit = Number.isFinite(retryLimit);

  let attempt = workerState.nextAttempt;
  if (hasRetryLimit && attempt > retryLimit) {
    throw new Error(
      `No attempts remaining: next attempt ${attempt} exceeds max retries ${config.maxRetries}`,
    );
  }

  const codex = createCodexRunner({
    codexHome: config.codexHome,
    model: config.codexModel,
    workingDirectory: config.workingDirectory,
    threadId: workerState.threadId,
    taskId: config.taskId,
    manifestPath: config.manifestPath,
    specPath: config.specPath,
  });

  const strictTddEnabled = manifest.tdd_mode === "strict";
  const testPaths = resolveTestPaths(manifest.test_paths, config.defaultTestPaths);
  const lintCommand = resolveLintCommand(manifest, config.lintCmd);
  const declaredWriteGlobs = normalizeWriteGlobs(manifest.files?.writes);

  let pendingBootstrapResults = bootstrapResults.length > 0 ? bootstrapResults : undefined;
  let fastFailureOutput: string | null = null;
  let lastFailure: { type: "lint" | "doctor" | "codex" | "command"; output: string } | null = null;
  let lastAttemptSummary: string | null = null;
  let loggedResumeEvent = false;
  const shouldRetryAttempt = (currentAttempt: number): boolean =>
    !hasRetryLimit || currentAttempt < retryLimit;
  const consumeBootstrapResults = (): BootstrapCommandSummary[] | undefined => {
    if (!pendingBootstrapResults || pendingBootstrapResults.length === 0) {
      return undefined;
    }
    const current = pendingBootstrapResults;
    pendingBootstrapResults = undefined;
    return current;
  };

  if (strictTddEnabled) {
    let stageAPromptKind: PromptKind = "initial";
    let stageAComplete = false;

    while (!stageAComplete && (!hasRetryLimit || attempt <= retryLimit)) {
      const stageAResult = await runStrictTddStageA({
        attempt,
        promptKind: stageAPromptKind,
        lastAttemptSummary,
        taskId: config.taskId,
        manifest,
        manifestPath: config.manifestPath,
        spec,
        taskBranch: config.taskBranch,
        codex,
        workerState,
        log,
        loggedResumeEvent,
        logCodexPrompts,
        workingDirectory: config.workingDirectory,
        checkpointCommits: config.checkpointCommits,
        testPaths,
        fastCommand: manifest.verify?.fast,
        doctorTimeoutSeconds: config.doctorTimeoutSeconds,
        runLogsDir: config.runLogsDir,
        commandEnv,
        declaredWriteGlobs,
        bootstrapResults: pendingBootstrapResults,
      });

      if (stageAResult.status === "skipped") {
        stageAComplete = true;
        break;
      }

      lastAttemptSummary = stageAResult.promptSummary;
      loggedResumeEvent = stageAResult.loggedResumeEvent;
      if (stageAResult.bootstrapConsumed) {
        pendingBootstrapResults = undefined;
      }

      if (stageAResult.status === "retry") {
        if (!hasRetryLimit || stageAResult.nextAttempt <= retryLimit) {
          if (!hasRetryLimit || attempt < retryLimit) {
            log.log({ type: "task.retry", attempt: stageAResult.nextAttempt });
          }
          attempt = stageAResult.nextAttempt;
          stageAPromptKind = "retry";
          continue;
        }
        attempt = stageAResult.nextAttempt;
        break;
      }

      attempt = stageAResult.nextAttempt;
      fastFailureOutput = stageAResult.fastOutput;
      stageAComplete = true;
    }

    if (hasRetryLimit && attempt > retryLimit) {
      log.log({ type: "tdd.stage.fail", payload: { stage: "A", reason: "max_retries" } });
      log.log({ type: "task.failed", payload: { attempts: config.maxRetries } });
      throw new Error(`Max retries exceeded (${config.maxRetries})`);
    }
  }

  let isFirstImplementationAttempt = true;
  let stageBStarted = false;

  for (; !hasRetryLimit || attempt <= retryLimit; attempt += 1) {
    if (strictTddEnabled && !stageBStarted) {
      log.log({
        type: "tdd.stage.start",
        attempt,
        payload: { stage: "B", mode: "strict" },
      });
      stageBStarted = true;
    }

    const prompt = isFirstImplementationAttempt
      ? buildInitialPrompt({
          spec,
          manifest,
          manifestPath: config.manifestPath,
          taskBranch: config.taskBranch,
          lastAttemptSummary,
          declaredWriteGlobs,
          strictTddContext: strictTddEnabled
            ? { stage: "implementation", testPaths, fastFailureOutput: fastFailureOutput ?? undefined }
            : undefined,
        })
      : buildRetryPrompt({
          spec,
          lastFailure: lastFailure ?? { type: "doctor", output: "" },
          failedAttempt: attempt - 1,
          lastAttemptSummary,
          declaredWriteGlobs,
        });

    const promptKind: PromptKind = isFirstImplementationAttempt ? "initial" : "retry";
    const bootstrapForAttempt = consumeBootstrapResults();

    let codexError: unknown = null;
    try {
      loggedResumeEvent = await runCodexTurn({
        attempt,
        codex,
        log,
        workerState,
        loggedResumeEvent,
        logCodexPrompts,
        prompt,
        runLogsDir: config.runLogsDir,
      });
    } catch (err) {
      codexError = err;
    }
    isFirstImplementationAttempt = false;

    if (codexError) {
      const errorMessage = toErrorMessage(codexError);
      const errorLog = `codex-error-${safeAttemptName(attempt)}.log`;
      writeRunLog(config.runLogsDir, errorLog, `${errorMessage}\n`);

      const retryReason: RetryReason = {
        reason_code: "codex_error",
        human_readable_reason: "Codex turn failed. Retrying.",
        evidence_paths: [errorLog],
      };
      const commands = buildCommandsSummary({ bootstrap: bootstrapForAttempt });
      const summaryResult = await recordAttemptSummary({
        attempt,
        phase: "implementation",
        promptKind,
        declaredWriteGlobs,
        runLogsDir: config.runLogsDir,
        workingDirectory: config.workingDirectory,
        log,
        retry: retryReason,
        commands,
      });
      lastAttemptSummary = summaryResult.promptSummary;
      lastFailure = { type: "codex", output: errorMessage.slice(0, DOCTOR_PROMPT_LIMIT) };

      if (shouldRetryAttempt(attempt)) {
        log.log({ type: "task.retry", attempt: attempt + 1 });
      }
      continue;
    }

    if (config.checkpointCommits) {
      await maybeCheckpointCommit({
        cwd: config.workingDirectory,
        taskId: config.taskId,
        attempt,
        log,
        workerState,
      });
    } else {
      log.log({
        type: "git.checkpoint.skip",
        attempt,
        payload: { reason: "disabled" },
      });
    }

    let lintSummary: CommandSummary | undefined;
    if (lintCommand) {
      const lintPayload: JsonObject = { command: lintCommand };
      if (config.lintTimeoutSeconds !== undefined) {
        lintPayload.timeout_seconds = config.lintTimeoutSeconds;
      }

      log.log({ type: "lint.start", attempt, payload: lintPayload });

      let lintOutput = "";
      let lintExitCode = -1;
      let lintError: unknown = null;
      try {
        const lint = await runVerificationCommand({
          command: lintCommand,
          cwd: config.workingDirectory,
          timeoutSeconds: config.lintTimeoutSeconds,
          env: commandEnv,
        });
        lintOutput = lint.output.trim();
        lintExitCode = lint.exitCode;
      } catch (err) {
        lintError = err;
        lintOutput = toErrorMessage(err);
      }

      const lintLogFile = lintError
        ? `lint-error-${safeAttemptName(attempt)}.log`
        : `lint-attempt-${safeAttemptName(attempt)}.log`;
      writeRunLog(config.runLogsDir, lintLogFile, lintOutput + "\n");

      lintSummary = buildCommandSummary({
        command: lintCommand,
        exitCode: lintExitCode,
        output: lintOutput,
        logPath: lintLogFile,
      });

      if (lintError) {
        const retryReason: RetryReason = {
          reason_code: "lint_error",
          human_readable_reason: "Lint command failed to run.",
          evidence_paths: [lintLogFile],
        };
        const summaryResult = await recordAttemptSummary({
          attempt,
          phase: "implementation",
          promptKind,
          declaredWriteGlobs,
          runLogsDir: config.runLogsDir,
          workingDirectory: config.workingDirectory,
          log,
          retry: retryReason,
          commands: buildCommandsSummary({ bootstrap: bootstrapForAttempt, lint: lintSummary }),
        });
        lastAttemptSummary = summaryResult.promptSummary;
        lastFailure = { type: "command", output: lintOutput.slice(0, DOCTOR_PROMPT_LIMIT) };
        log.log({
          type: "lint.fail",
          attempt,
          payload: { exit_code: lintExitCode, summary: lintOutput.slice(0, 500) },
        });

        if (shouldRetryAttempt(attempt)) {
          log.log({ type: "task.retry", attempt: attempt + 1 });
        }
        continue;
      }

      if (lintExitCode === 0) {
        log.log({ type: "lint.pass", attempt });
      } else {
        const lintPromptOutput = lintOutput.slice(0, DOCTOR_PROMPT_LIMIT);
        lastFailure = { type: "lint", output: lintPromptOutput };
        log.log({
          type: "lint.fail",
          attempt,
          payload: {
            exit_code: lintExitCode,
            summary: lintPromptOutput.slice(0, 500),
          },
        });

        const retryReason: RetryReason = {
          reason_code: "lint_failed",
          human_readable_reason: "Lint failed. Fix lint issues before continuing.",
          evidence_paths: [lintLogFile],
        };
        const summaryResult = await recordAttemptSummary({
          attempt,
          phase: "implementation",
          promptKind,
          declaredWriteGlobs,
          runLogsDir: config.runLogsDir,
          workingDirectory: config.workingDirectory,
          log,
          retry: retryReason,
          commands: buildCommandsSummary({ bootstrap: bootstrapForAttempt, lint: lintSummary }),
        });
        lastAttemptSummary = summaryResult.promptSummary;

        if (shouldRetryAttempt(attempt)) {
          log.log({ type: "task.retry", attempt: attempt + 1 });
        }
        continue;
      }
    }

    const doctorPayload: JsonObject = { command: config.doctorCmd };
    if (config.doctorTimeoutSeconds !== undefined) {
      doctorPayload.timeout_seconds = config.doctorTimeoutSeconds;
    }

    log.log({ type: "doctor.start", attempt, payload: doctorPayload });

    let doctorOutput = "";
    let doctorExitCode = -1;
    let doctorError: unknown = null;
    try {
      const doctor = await runVerificationCommand({
        command: config.doctorCmd,
        cwd: config.workingDirectory,
        timeoutSeconds: config.doctorTimeoutSeconds,
        env: commandEnv,
      });
      doctorOutput = doctor.output.trim();
      doctorExitCode = doctor.exitCode;
    } catch (err) {
      doctorError = err;
      doctorOutput = toErrorMessage(err);
    }

    const doctorLogFile = doctorError
      ? `doctor-error-${safeAttemptName(attempt)}.log`
      : `doctor-${safeAttemptName(attempt)}.log`;
    writeRunLog(config.runLogsDir, doctorLogFile, doctorOutput + "\n");

    const doctorSummary = buildCommandSummary({
      command: config.doctorCmd,
      exitCode: doctorExitCode,
      output: doctorOutput,
      logPath: doctorLogFile,
    });

    if (doctorError) {
      const retryReason: RetryReason = {
        reason_code: "doctor_error",
        human_readable_reason: "Doctor command failed to run.",
        evidence_paths: [doctorLogFile],
      };
      const summaryResult = await recordAttemptSummary({
        attempt,
        phase: "implementation",
        promptKind,
        declaredWriteGlobs,
        runLogsDir: config.runLogsDir,
        workingDirectory: config.workingDirectory,
        log,
        retry: retryReason,
        commands: buildCommandsSummary({
          bootstrap: bootstrapForAttempt,
          lint: lintSummary,
          doctor: doctorSummary,
        }),
      });
      lastAttemptSummary = summaryResult.promptSummary;
      lastFailure = { type: "command", output: doctorOutput.slice(0, DOCTOR_PROMPT_LIMIT) };
      log.log({
        type: "doctor.fail",
        attempt,
        payload: { exit_code: doctorExitCode, summary: doctorOutput.slice(0, 500) },
      });

      if (shouldRetryAttempt(attempt)) {
        log.log({ type: "task.retry", attempt: attempt + 1 });
      }
      continue;
    }

    if (doctorExitCode === 0) {
      log.log({ type: "doctor.pass", attempt });
      if (strictTddEnabled) {
        log.log({ type: "tdd.stage.pass", attempt, payload: { stage: "B", mode: "strict" } });
      }
      const summaryResult = await recordAttemptSummary({
        attempt,
        phase: "implementation",
        promptKind,
        declaredWriteGlobs,
        runLogsDir: config.runLogsDir,
        workingDirectory: config.workingDirectory,
        log,
        commands: buildCommandsSummary({
          bootstrap: bootstrapForAttempt,
          lint: lintSummary,
          doctor: doctorSummary,
        }),
      });
      lastAttemptSummary = summaryResult.promptSummary;
      await maybeCommit({
        cwd: config.workingDirectory,
        manifest,
        taskId: config.taskId,
        attempt,
        log,
        workerState: config.checkpointCommits ? workerState : undefined,
      });
      log.log({ type: "task.complete", attempt });
      return;
    }

    lastFailure = { type: "doctor", output: doctorOutput.slice(0, DOCTOR_PROMPT_LIMIT) };
    log.log({
      type: "doctor.fail",
      attempt,
      payload: {
        exit_code: doctorExitCode,
        summary: lastFailure.output.slice(0, 500),
      },
    });

    const retryReason: RetryReason = {
      reason_code: "doctor_failed",
      human_readable_reason: "Doctor failed. Fix issues and retry.",
      evidence_paths: [doctorLogFile],
    };
    const summaryResult = await recordAttemptSummary({
      attempt,
      phase: "implementation",
      promptKind,
      declaredWriteGlobs,
      runLogsDir: config.runLogsDir,
      workingDirectory: config.workingDirectory,
      log,
      retry: retryReason,
      commands: buildCommandsSummary({
        bootstrap: bootstrapForAttempt,
        lint: lintSummary,
        doctor: doctorSummary,
      }),
    });
    lastAttemptSummary = summaryResult.promptSummary;

    if (shouldRetryAttempt(attempt)) {
      log.log({ type: "task.retry", attempt: attempt + 1 });
    }
  }

  if (hasRetryLimit && strictTddEnabled) {
    log.log({ type: "tdd.stage.fail", payload: { stage: "B", reason: "max_retries" } });
  }
  if (hasRetryLimit) {
    log.log({ type: "task.failed", payload: { attempts: config.maxRetries } });
    throw new Error(`Max retries exceeded (${config.maxRetries})`);
  }
}

// =============================================================================
// PROMPTS
// =============================================================================

function buildInitialPrompt(args: {
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
    "Prefer `mycelium cp` for ownership, dependencies, blast radius, and symbol navigation.",
    "- mycelium cp components list",
    "- mycelium cp owner <path>",
    "- mycelium cp blast <path>",
    "- mycelium cp symbols find <query>",
    "- mycelium cp symbols def <symbol>",
    "- mycelium cp symbols refs <symbol>",
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

function buildRetryPrompt(args: {
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
    failureOutput.length > 0
      ? failureOutput
      : `<no ${args.lastFailure.type} output captured>`;
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

function buildWriteScopeSection(globs: string[]): string {
  const normalized = normalizeWriteGlobs(globs);
  const scopeLines = [
    "Declared write scope (manifest files.writes):",
    normalized.length > 0 ? `- ${normalized.join("\n- ")}` : "- <none declared>",
    "If you must touch files outside this set, proceed but explicitly report the divergence (list files + why). Do not abort.",
  ];
  return scopeLines.join("\n");
}

// =============================================================================
// EXECUTION HELPERS
// =============================================================================

async function loadTaskInputs(specPath: string, manifestPath: string): Promise<{
  spec: string;
  manifest: TaskManifest;
}> {
  const [specRaw, manifestRaw] = await Promise.all([
    fs.readFile(specPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
  ]);

  let manifest: TaskManifest;
  try {
    manifest = JSON.parse(manifestRaw) as TaskManifest;
  } catch (err) {
    throw new Error(`Failed to parse manifest at ${manifestPath}: ${toErrorMessage(err)}`);
  }

  return { spec: specRaw, manifest };
}

async function runStrictTddStageA(args: {
  attempt: number;
  promptKind: PromptKind;
  lastAttemptSummary?: string | null;
  taskId: string;
  manifest: TaskManifest;
  manifestPath: string;
  spec: string;
  taskBranch?: string;
  codex: CodexRunnerLike;
  workerState: WorkerStateStore;
  log: WorkerLogger;
  loggedResumeEvent: boolean;
  logCodexPrompts: boolean;
  workingDirectory: string;
  checkpointCommits: boolean;
  testPaths: string[];
  fastCommand?: string;
  doctorTimeoutSeconds?: number;
  runLogsDir: string;
  commandEnv: NodeJS.ProcessEnv;
  declaredWriteGlobs: string[];
  bootstrapResults?: BootstrapCommandSummary[];
}): Promise<
  | {
      status: "ready";
      nextAttempt: number;
      fastOutput: string;
      loggedResumeEvent: boolean;
      promptSummary: string;
      bootstrapConsumed: boolean;
    }
  | {
      status: "retry";
      nextAttempt: number;
      loggedResumeEvent: boolean;
      promptSummary: string;
      bootstrapConsumed: boolean;
    }
  | { status: "skipped"; reason: string; loggedResumeEvent: boolean }
> {
  const fastCommand = args.fastCommand?.trim();
  if (!fastCommand) {
    args.log.log({
      type: "tdd.stage.skip",
      attempt: args.attempt,
      payload: { stage: "A", reason: "missing_fast_command" },
    });
    return {
      status: "skipped",
      reason: "missing_fast_command",
      loggedResumeEvent: args.loggedResumeEvent,
    };
  }

  if (args.testPaths.length === 0) {
    args.log.log({
      type: "tdd.stage.skip",
      attempt: args.attempt,
      payload: { stage: "A", reason: "missing_test_paths" },
    });
    return {
      status: "skipped",
      reason: "missing_test_paths",
      loggedResumeEvent: args.loggedResumeEvent,
    };
  }

  args.log.log({
    type: "tdd.stage.start",
    attempt: args.attempt,
    payload: { stage: "A", mode: "strict", test_paths: args.testPaths },
  });

  const beforeChanges = await listChangedPaths(args.workingDirectory);

  const prompt = buildInitialPrompt({
    spec: args.spec,
    manifest: args.manifest,
    manifestPath: args.manifestPath,
    taskBranch: args.taskBranch,
    lastAttemptSummary: args.lastAttemptSummary,
    declaredWriteGlobs: args.declaredWriteGlobs,
    strictTddContext: { stage: "tests", testPaths: args.testPaths },
  });

  let loggedResumeEvent = args.loggedResumeEvent;
  let codexError: unknown = null;
  try {
    loggedResumeEvent = await runCodexTurn({
      attempt: args.attempt,
      codex: args.codex,
      log: args.log,
      workerState: args.workerState,
      loggedResumeEvent,
      logCodexPrompts: args.logCodexPrompts,
      prompt,
      runLogsDir: args.runLogsDir,
    });
  } catch (err) {
    codexError = err;
  }

  const bootstrapConsumed = Boolean(args.bootstrapResults?.length);
  const commandSummary = buildCommandsSummary({ bootstrap: args.bootstrapResults });

  if (codexError) {
    const errorMessage = toErrorMessage(codexError);
    const errorLog = `codex-error-${safeAttemptName(args.attempt)}.log`;
    writeRunLog(args.runLogsDir, errorLog, `${errorMessage}\n`);

    const retryReason: RetryReason = {
      reason_code: "codex_error",
      human_readable_reason: "Codex turn failed. Retrying.",
      evidence_paths: [errorLog],
    };

    const summaryResult = await recordAttemptSummary({
      attempt: args.attempt,
      phase: "tdd_stage_a",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      commands: commandSummary,
    });

    return {
      status: "retry",
      nextAttempt: args.attempt + 1,
      loggedResumeEvent,
      promptSummary: summaryResult.promptSummary,
      bootstrapConsumed,
    };
  }

  const afterChanges = await listChangedPaths(args.workingDirectory);
  const newChanges = diffChangedPaths(beforeChanges, afterChanges);
  const filteredChanges = filterInternalChanges(newChanges, args.workingDirectory, args.runLogsDir);
  const currentChanges = filterInternalChanges(afterChanges, args.workingDirectory, args.runLogsDir);
  const nonTestChanges = currentChanges.filter((file) => !isTestPath(file, args.testPaths));

  if (nonTestChanges.length > 0) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "non_test_changes", files: nonTestChanges },
    });
    await cleanNonTestChanges({
      cwd: args.workingDirectory,
      files: nonTestChanges,
      log: args.log,
      attempt: args.attempt,
    });

    const retryReason: RetryReason = {
      reason_code: "non_test_changes",
      human_readable_reason: "Changes outside test_paths detected; reverted non-test changes.",
      evidence_paths: [],
    };
    const summaryResult = await recordAttemptSummary({
      attempt: args.attempt,
      phase: "tdd_stage_a",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      tdd: { non_test_changes_detected: nonTestChanges },
      commands: commandSummary,
    });

    return {
      status: "retry",
      nextAttempt: args.attempt + 1,
      loggedResumeEvent,
      promptSummary: summaryResult.promptSummary,
      bootstrapConsumed,
    };
  }

  let fastOutput = "";
  let fastExitCode = -1;
  let fastError: unknown = null;
  try {
    const fast = await runVerificationCommand({
      command: fastCommand,
      cwd: args.workingDirectory,
      timeoutSeconds: args.doctorTimeoutSeconds,
      env: args.commandEnv,
    });
    fastOutput = fast.output.trim();
    fastExitCode = fast.exitCode;
  } catch (err) {
    fastError = err;
    fastOutput = toErrorMessage(err);
  }

  const fastLogFile = fastError
    ? `verify-fast-error-${safeAttemptName(args.attempt)}.log`
    : `verify-fast-${safeAttemptName(args.attempt)}.log`;
  writeRunLog(args.runLogsDir, fastLogFile, fastOutput + "\n");

  if (fastError) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "fast_error" },
    });

    const retryReason: RetryReason = {
      reason_code: "fast_error",
      human_readable_reason: "verify.fast failed to run.",
      evidence_paths: [fastLogFile],
    };
    const summaryResult = await recordAttemptSummary({
      attempt: args.attempt,
      phase: "tdd_stage_a",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      tdd: {
        fast_exit_code: fastExitCode,
        fast_output_preview: fastOutput.slice(0, OUTPUT_PREVIEW_LIMIT),
      },
      commands: commandSummary,
    });

    return {
      status: "retry",
      nextAttempt: args.attempt + 1,
      loggedResumeEvent,
      promptSummary: summaryResult.promptSummary,
      bootstrapConsumed,
    };
  }

  if (fastExitCode === 0) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "fast_passed" },
    });

    const retryReason: RetryReason = {
      reason_code: "fast_passed",
      human_readable_reason: "verify.fast passed unexpectedly; tests must fail first.",
      evidence_paths: [fastLogFile],
    };
    const summaryResult = await recordAttemptSummary({
      attempt: args.attempt,
      phase: "tdd_stage_a",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      tdd: {
        fast_exit_code: fastExitCode,
        fast_output_preview: fastOutput.slice(0, OUTPUT_PREVIEW_LIMIT),
      },
      commands: commandSummary,
    });

    return {
      status: "retry",
      nextAttempt: args.attempt + 1,
      loggedResumeEvent,
      promptSummary: summaryResult.promptSummary,
      bootstrapConsumed,
    };
  }

  args.log.log({
    type: "tdd.stage.pass",
    attempt: args.attempt,
    payload: {
      stage: "A",
      mode: "strict",
      exit_code: fastExitCode,
      files_changed: filteredChanges.length,
    },
  });

  const summaryResult = await recordAttemptSummary({
    attempt: args.attempt,
    phase: "tdd_stage_a",
    promptKind: args.promptKind,
    declaredWriteGlobs: args.declaredWriteGlobs,
    runLogsDir: args.runLogsDir,
    workingDirectory: args.workingDirectory,
    log: args.log,
    tdd: {
      fast_exit_code: fastExitCode,
      fast_output_preview: fastOutput.slice(0, OUTPUT_PREVIEW_LIMIT),
    },
    commands: commandSummary,
  });

  if (args.checkpointCommits) {
    await maybeCheckpointCommit({
      cwd: args.workingDirectory,
      taskId: args.taskId,
      attempt: args.attempt,
      log: args.log,
      workerState: args.workerState,
    });
  } else {
    args.log.log({
      type: "git.checkpoint.skip",
      attempt: args.attempt,
      payload: { reason: "disabled" },
    });
  }

  return {
    status: "ready",
    nextAttempt: args.attempt + 1,
    fastOutput: fastOutput.slice(0, DOCTOR_PROMPT_LIMIT),
    loggedResumeEvent,
    promptSummary: summaryResult.promptSummary,
    bootstrapConsumed,
  };
}

async function runCodexTurn(args: {
  attempt: number;
  prompt: string;
  codex: CodexRunnerLike;
  log: WorkerLogger;
  workerState: WorkerStateStore;
  loggedResumeEvent: boolean;
  logCodexPrompts: boolean;
  runLogsDir: string;
}): Promise<boolean> {
  await args.workerState.recordAttemptStart(args.attempt);
  args.log.log({ type: "turn.start", attempt: args.attempt });

  const promptPreview = truncateText(args.prompt, PROMPT_PREVIEW_LIMIT);
  const shouldPersistPrompt = args.logCodexPrompts;
  const promptLogFile = shouldPersistPrompt
    ? `codex-prompt-${safeAttemptName(args.attempt)}.txt`
    : undefined;
  if (promptLogFile) {
    writeRunLog(args.runLogsDir, promptLogFile, `${args.prompt}\n`);
  }

  const promptPayload: JsonObject = {
    preview: promptPreview.text,
    truncated: promptPreview.truncated,
    length: args.prompt.length,
  };
  if (promptLogFile) {
    promptPayload.run_logs_file = promptLogFile;
  }
  args.log.log({
    type: "codex.prompt",
    attempt: args.attempt,
    payload: promptPayload,
  });

  let hasLoggedResume = args.loggedResumeEvent;
  await args.codex.streamPrompt(args.prompt, {
    onThreadResumed: (threadId: string) => {
      if (!hasLoggedResume) {
        args.log.log({
          type: "codex.thread.resumed",
          attempt: args.attempt,
          payload: { thread_id: threadId },
        });
        hasLoggedResume = true;
      }
    },
    onThreadStarted: async (threadId: string) => {
      await args.workerState.recordThreadId(threadId);
      args.log.log({
        type: "codex.thread.started",
        attempt: args.attempt,
        payload: { thread_id: threadId },
      });
    },
    onEvent: (event: unknown) =>
      args.log.log({
        type: "codex.event",
        attempt: args.attempt,
        payload: { event } as JsonObject,
      }),
  });

  args.log.log({ type: "turn.complete", attempt: args.attempt });
  return hasLoggedResume;
}

async function runBootstrap(args: {
  commands: string[];
  cwd: string;
  log: WorkerLogger;
  runLogsDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BootstrapCommandSummary[]> {
  const cmds = args.commands.filter((cmd) => cmd.trim().length > 0);
  if (cmds.length === 0) {
    return [];
  }

  const summaries: BootstrapCommandSummary[] = [];
  args.log.log({ type: "bootstrap.start", payload: { command_count: cmds.length } });

  for (let i = 0; i < cmds.length; i += 1) {
    const cmd = cmds[i];
    args.log.log({ type: "bootstrap.cmd.start", payload: { cmd, index: i } });

    const res = await execaCommand(cmd, {
      cwd: args.cwd,
      shell: true,
      reject: false,
      stdio: "pipe",
      env: args.env ?? process.env,
    });

    const output = `${res.stdout}\n${res.stderr}`.trim();
    const logFile = output ? `bootstrap-${safeAttemptName(i + 1)}.log` : undefined;
    if (logFile) {
      writeRunLog(args.runLogsDir, logFile, output + "\n");
    }

    const stdoutPreview = truncateText(res.stdout, OUTPUT_PREVIEW_LIMIT);
    const stderrPreview = truncateText(res.stderr, OUTPUT_PREVIEW_LIMIT);
    const exitCode = res.exitCode ?? -1;

    const summary: BootstrapCommandSummary = {
      index: i + 1,
      command: cmd,
      exit_code: exitCode,
    };
    if (output.length > 0) {
      summary.output_preview = output.slice(0, OUTPUT_PREVIEW_LIMIT);
    }
    if (logFile) {
      summary.log_path = logFile;
    }
    summaries.push(summary);

    args.log.log({
      type: exitCode === 0 ? "bootstrap.cmd.complete" : "bootstrap.cmd.fail",
      payload: {
        cmd,
        exit_code: exitCode,
        stdout: stdoutPreview.text,
        stdout_truncated: stdoutPreview.truncated,
        stderr: stderrPreview.text,
        stderr_truncated: stderrPreview.truncated,
      },
    });

    if (exitCode !== 0) {
      throw new Error(`Bootstrap command failed: "${cmd}" exited with ${exitCode}`);
    }
  }

  args.log.log({ type: "bootstrap.complete" });
  return summaries;
}

async function runVerificationCommand(args: {
  command: string;
  cwd: string;
  timeoutSeconds?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; output: string }> {
  const res = await execaCommand(args.command, {
    cwd: args.cwd,
    shell: true,
    reject: false,
    timeout: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
    stdio: "pipe",
    env: args.env ?? process.env,
  });

  const exitCode = res.exitCode ?? -1;
  const output = `${res.stdout}\n${res.stderr}`.trim();
  return { exitCode, output };
}

function buildCommandSummary(args: {
  command: string;
  exitCode: number;
  output: string;
  logPath: string;
}): CommandSummary {
  const summary: CommandSummary = {
    command: args.command,
    exit_code: args.exitCode,
    log_path: args.logPath,
  };

  if (args.output.trim().length > 0) {
    summary.output_preview = args.output.slice(0, OUTPUT_PREVIEW_LIMIT);
  }

  return summary;
}

function buildCommandsSummary(args: {
  bootstrap?: BootstrapCommandSummary[];
  lint?: CommandSummary;
  doctor?: CommandSummary;
}): AttemptSummary["commands"] | undefined {
  const commands: AttemptSummary["commands"] = {};
  if (args.bootstrap && args.bootstrap.length > 0) {
    commands.bootstrap = args.bootstrap;
  }
  if (args.lint) {
    commands.lint = args.lint;
  }
  if (args.doctor) {
    commands.doctor = args.doctor;
  }
  return Object.keys(commands).length > 0 ? commands : undefined;
}

async function recordAttemptSummary(args: {
  attempt: number;
  phase: AttemptPhase;
  promptKind: PromptKind;
  declaredWriteGlobs: string[];
  runLogsDir: string;
  workingDirectory: string;
  log: WorkerLogger;
  retry?: RetryReason;
  tdd?: AttemptSummary["tdd"];
  commands?: AttemptSummary["commands"];
}): Promise<{ summary: AttemptSummary; promptSummary: string }> {
  const changedFiles = await listFilteredChanges(args.workingDirectory, args.runLogsDir);
  const summary = buildAttemptSummary({
    attempt: args.attempt,
    phase: args.phase,
    prompt_kind: args.promptKind,
    changed_files: changedFiles,
    declared_write_globs: args.declaredWriteGlobs,
    tdd: args.tdd,
    commands: args.commands,
    retry: args.retry,
  });

  const persisted = await persistAttemptSummary(args.runLogsDir, summary);
  if (summary.scope_divergence?.out_of_scope_files?.length) {
    args.log.log({
      type: "scope.divergence",
      attempt: args.attempt,
      payload: {
        declared_write_globs: summary.scope_divergence.declared_write_globs,
        out_of_scope_files: summary.scope_divergence.out_of_scope_files,
      },
    });
  }

  return { summary, promptSummary: persisted.promptSummary };
}

async function listFilteredChanges(workingDirectory: string, runLogsDir: string): Promise<string[]> {
  const changes = await listChangedPaths(workingDirectory);
  return filterInternalChanges(changes, workingDirectory, runLogsDir);
}

function resolveLintCommand(manifest: TaskManifest, fallback?: string): string | undefined {
  const manifestLint = manifest.verify?.lint?.trim() ?? "";
  if (manifestLint.length > 0) return manifestLint;

  const fallbackLint = fallback?.trim() ?? "";
  return fallbackLint.length > 0 ? fallbackLint : undefined;
}

async function ensureGitIdentity(cwd: string, log: WorkerLogger): Promise<void> {
  const nameRes = await execa("git", ["config", "--get", "user.name"], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  if (nameRes.exitCode !== 0 || nameRes.stdout.trim().length === 0) {
    await execa("git", ["config", "user.name", "mycelium"], { cwd });
    log.log({ type: "git.identity.set", payload: { field: "user.name" } });
  }

  const emailRes = await execa("git", ["config", "--get", "user.email"], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  if (emailRes.exitCode !== 0 || emailRes.stdout.trim().length === 0) {
    await execa("git", ["config", "user.email", "mycelium@localhost"], { cwd });
    log.log({ type: "git.identity.set", payload: { field: "user.email" } });
  }
}

type GitStatusEntry = {
  path: string;
  status: string;
};

async function listChangedEntries(cwd: string): Promise<GitStatusEntry[]> {
  const status = await execa("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    stdio: "pipe",
  });

  return status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const statusCode = line.length >= 2 ? line.slice(0, 2) : line;
      const pathText = line.length > 3 ? line.slice(3).trim() : "";
      const target = pathText.includes(" -> ")
        ? pathText.split(" -> ").pop() ?? pathText
        : pathText;
      return { status: statusCode, path: normalizeToPosix(target) };
    })
    .filter((entry) => entry.path.length > 0);
}

async function listChangedPaths(cwd: string): Promise<string[]> {
  const status = await execa("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    stdio: "pipe",
  });

  return status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const pathText = line.length > 3 ? line.slice(3).trim() : line;
      const target = pathText.includes(" -> ")
        ? pathText.split(" -> ").pop() ?? pathText
        : pathText;
      return normalizeToPosix(target);
    })
    .filter((file) => file.length > 0);
}

async function cleanNonTestChanges(args: {
  cwd: string;
  files: string[];
  log: WorkerLogger;
  attempt: number;
}): Promise<void> {
  if (args.files.length === 0) {
    return;
  }

  const entries = await listChangedEntries(args.cwd);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry.status]));
  const tracked: string[] = [];
  const untracked: string[] = [];

  for (const file of args.files) {
    if (entryMap.get(file) === "??") {
      untracked.push(file);
    } else {
      tracked.push(file);
    }
  }

  if (tracked.length > 0) {
    const restore = await execa(
      "git",
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked],
      { cwd: args.cwd, reject: false, stdio: "pipe" },
    );
    if (restore.exitCode !== 0) {
      args.log.log({
        type: "git.restore.fail",
        attempt: args.attempt,
        payload: { exit_code: restore.exitCode ?? -1 },
      });
    }
  }

  if (untracked.length > 0) {
    const clean = await execa("git", ["clean", "-fd", "--", ...untracked], {
      cwd: args.cwd,
      reject: false,
      stdio: "pipe",
    });
    if (clean.exitCode !== 0) {
      args.log.log({
        type: "git.clean.fail",
        attempt: args.attempt,
        payload: { exit_code: clean.exitCode ?? -1 },
      });
    }
  }
}

function diffChangedPaths(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((file) => !beforeSet.has(file)).sort();
}

function filterInternalChanges(files: string[], workingDirectory: string, runLogsDir: string): string[] {
  const logsRelative = normalizeToPosix(path.relative(workingDirectory, runLogsDir));
  return files.filter((file) => {
    if (file === ".mycelium/worker-state.json") return false;
    if (file.startsWith(".mycelium/codex-home/")) return false;
    if (file.startsWith(".git/")) return false;
    if (logsRelative && !logsRelative.startsWith("..") && logsRelative !== ".") {
      if (file === logsRelative || file.startsWith(`${logsRelative}/`)) return false;
    }
    return true;
  });
}

function normalizeToPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

function normalizeWriteGlobs(globs?: string[]): string[] {
  const normalized = (globs ?? [])
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
  return Array.from(new Set(normalized)).sort();
}

// =============================================================================
// GIT HELPERS
// =============================================================================

async function maybeCheckpointCommit(args: {
  cwd: string;
  taskId: string;
  attempt: number;
  log: WorkerLogger;
  workerState: WorkerStateStore;
}): Promise<void> {
  const status = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });
  if (status.stdout.trim().length === 0) {
    args.log.log({
      type: "git.checkpoint.skip",
      attempt: args.attempt,
      payload: { reason: "no_changes" },
    });
    return;
  }

  await execa("git", ["add", "-A"], { cwd: args.cwd });

  const message = buildCheckpointCommitMessage(args.taskId, args.attempt);
  const commit = await execa("git", ["commit", "-m", message], {
    cwd: args.cwd,
    reject: false,
    stdio: "pipe",
  });

  if (commit.exitCode === 0) {
    const sha = await readHeadSha(args.cwd);
    await args.workerState.recordCheckpoint(args.attempt, sha);
    args.log.log({ type: "git.checkpoint", attempt: args.attempt, payload: { sha } });
    return;
  }

  const statusAfter = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });
  if (statusAfter.stdout.trim().length === 0) {
    args.log.log({
      type: "git.checkpoint.skip",
      attempt: args.attempt,
      payload: { reason: "nothing_to_commit" },
    });
    return;
  }

  throw new Error(`git checkpoint commit failed: ${commit.stderr || commit.stdout}`);
}

async function maybeCommit(args: {
  cwd: string;
  manifest: TaskManifest;
  taskId: string;
  attempt: number;
  log: WorkerLogger;
  workerState?: WorkerStateStore;
}): Promise<void> {
  const status = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });

  const taskName =
    typeof args.manifest.name === "string" && args.manifest.name.trim().length > 0
      ? args.manifest.name
      : args.taskId;
  const message = `[FEAT] ${args.taskId} ${taskName}\n\nTask: ${args.taskId}`;

  if (status.stdout.trim().length === 0) {
    const headMessage = await readHeadCommitMessage(args.cwd);
    if (isCheckpointCommitMessage(headMessage, args.taskId)) {
      const amend = await execa("git", ["commit", "--amend", "-m", message], {
        cwd: args.cwd,
        reject: false,
        stdio: "pipe",
      });

      if (amend.exitCode !== 0) {
        throw new Error(`git commit amend failed: ${amend.stderr || amend.stdout}`);
      }

      const sha = await readHeadSha(args.cwd);
      if (args.workerState) {
        await args.workerState.recordCheckpoint(args.attempt, sha);
      }
      args.log.log({
        type: "git.commit",
        attempt: args.attempt,
        payload: { sha, amended_checkpoint: true },
      });
      return;
    }

    args.log.log({
      type: "git.commit.skip",
      attempt: args.attempt,
      payload: { reason: "no_changes" },
    });
    return;
  }

  await execa("git", ["add", "-A"], { cwd: args.cwd });

  const commit = await execa("git", ["commit", "-m", message], {
    cwd: args.cwd,
    reject: false,
    stdio: "pipe",
  });

  if (commit.exitCode === 0) {
    const sha = await readHeadSha(args.cwd);
    if (args.workerState) {
      await args.workerState.recordCheckpoint(args.attempt, sha);
    }
    args.log.log({ type: "git.commit", attempt: args.attempt, payload: { sha } });
    return;
  }

  const statusAfter = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });
  if (statusAfter.stdout.trim().length === 0) {
    args.log.log({
      type: "git.commit.skip",
      attempt: args.attempt,
      payload: { reason: "nothing_to_commit" },
    });
    return;
  }

  throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

async function readHeadCommitMessage(cwd: string): Promise<string | null> {
  try {
    const res = await execa("git", ["log", "-1", "--pretty=%B"], { cwd, stdio: "pipe" });
    const message = res.stdout.trim();
    return message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

async function readHeadSha(cwd: string): Promise<string> {
  const res = await execa("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" });
  return res.stdout.trim();
}

function buildCheckpointCommitMessage(taskId: string, attempt: number): string {
  return `WIP(Task ${taskId}): attempt ${attempt} checkpoint`;
}

function isCheckpointCommitMessage(message: string | null, taskId: string): boolean {
  if (!message) return false;
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  return firstLine.startsWith(`WIP(Task ${taskId})`) && firstLine.toLowerCase().includes("checkpoint");
}

// =============================================================================
// UTILITIES
// =============================================================================

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}
