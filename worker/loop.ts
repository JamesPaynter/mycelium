import fs from "node:fs/promises";
import path from "node:path";

import { execa, execaCommand } from "execa";

import { isTestPath, resolveTestPaths } from "../src/core/test-paths.js";
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
};

const DOCTOR_PROMPT_LIMIT = 12_000;
const OUTPUT_PREVIEW_LIMIT = 4_000;
const PROMPT_PREVIEW_LIMIT = 4_000;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runWorker(config: WorkerConfig, logger?: WorkerLogger): Promise<void> {
  const log = logger ?? createStdoutLogger({ taskId: config.taskId, taskSlug: config.taskSlug });

  if (config.maxRetries < 1) {
    throw new Error(`maxRetries must be at least 1 (received ${config.maxRetries})`);
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

  if (config.bootstrapCmds.length > 0) {
    await runBootstrap({
      commands: config.bootstrapCmds,
      cwd: config.workingDirectory,
      log,
      runLogsDir: config.runLogsDir,
      env: commandEnv,
    });
  }

  await fs.mkdir(config.codexHome, { recursive: true });

  const workerState = new WorkerStateStore(config.workingDirectory);
  await workerState.load();

  let attempt = workerState.nextAttempt;
  if (attempt > config.maxRetries) {
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

  let fastFailureOutput: string | null = null;
  let lastFailure: { type: "lint" | "doctor"; output: string } | null = null;
  let loggedResumeEvent = false;

  if (strictTddEnabled) {
    const stageAResult = await runStrictTddStageA({
      attempt,
      taskId: config.taskId,
      manifest,
      manifestPath: config.manifestPath,
      spec,
      taskBranch: config.taskBranch,
      codex,
      workerState,
      log,
      loggedResumeEvent,
      workingDirectory: config.workingDirectory,
      checkpointCommits: config.checkpointCommits,
      testPaths,
      fastCommand: manifest.verify?.fast,
      doctorTimeoutSeconds: config.doctorTimeoutSeconds,
      runLogsDir: config.runLogsDir,
      commandEnv,
    });
    attempt = stageAResult.nextAttempt;
    fastFailureOutput = stageAResult.fastOutput;
    loggedResumeEvent = stageAResult.loggedResumeEvent;
  }

  let isFirstImplementationAttempt = true;
  let stageBStarted = false;

  for (; attempt <= config.maxRetries; attempt += 1) {
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
          strictTddContext: strictTddEnabled
            ? { stage: "implementation", testPaths, fastFailureOutput: fastFailureOutput ?? undefined }
            : undefined,
        })
      : buildRetryPrompt({
          spec,
          lastFailure: lastFailure ?? { type: "doctor", output: "" },
          failedAttempt: attempt - 1,
        });

    loggedResumeEvent = await runCodexTurn({
      attempt,
      codex,
      log,
      workerState,
      loggedResumeEvent,
      prompt,
      runLogsDir: config.runLogsDir,
    });
    isFirstImplementationAttempt = false;

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

    if (lintCommand) {
      const lintPayload: JsonObject = { command: lintCommand };
      if (config.lintTimeoutSeconds !== undefined) {
        lintPayload.timeout_seconds = config.lintTimeoutSeconds;
      }

      log.log({ type: "lint.start", attempt, payload: lintPayload });

      const lint = await runVerificationCommand({
        command: lintCommand,
        cwd: config.workingDirectory,
        timeoutSeconds: config.lintTimeoutSeconds,
        env: commandEnv,
      });

      const lintOutput = lint.output.trim();
      writeRunLog(
        config.runLogsDir,
        `lint-attempt-${safeAttemptName(attempt)}.log`,
        lintOutput + "\n",
      );

      if (lint.exitCode === 0) {
        log.log({ type: "lint.pass", attempt });
      } else {
        const lintPromptOutput = lintOutput.slice(0, DOCTOR_PROMPT_LIMIT);
        lastFailure = { type: "lint", output: lintPromptOutput };
        log.log({
          type: "lint.fail",
          attempt,
          payload: {
            exit_code: lint.exitCode,
            summary: lintPromptOutput.slice(0, 500),
          },
        });

        if (attempt < config.maxRetries) {
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

    const doctor = await runVerificationCommand({
      command: config.doctorCmd,
      cwd: config.workingDirectory,
      timeoutSeconds: config.doctorTimeoutSeconds,
      env: commandEnv,
    });

    const doctorOutput = doctor.output.trim();
    writeRunLog(config.runLogsDir, `doctor-${safeAttemptName(attempt)}.log`, doctorOutput + "\n");

    if (doctor.exitCode === 0) {
      log.log({ type: "doctor.pass", attempt });
      if (strictTddEnabled) {
        log.log({ type: "tdd.stage.pass", attempt, payload: { stage: "B", mode: "strict" } });
      }
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
        exit_code: doctor.exitCode,
        summary: lastFailure.output.slice(0, 500),
      },
    });

    if (attempt < config.maxRetries) {
      log.log({ type: "task.retry", attempt: attempt + 1 });
    }
  }

  if (strictTddEnabled) {
    log.log({ type: "tdd.stage.fail", payload: { stage: "B", reason: "max_retries" } });
  }
  log.log({ type: "task.failed", payload: { attempts: config.maxRetries } });
  throw new Error(`Max retries exceeded (${config.maxRetries})`);
}

// =============================================================================
// PROMPTS
// =============================================================================

function buildInitialPrompt(args: {
  spec: string;
  manifest: TaskManifest;
  manifestPath: string;
  taskBranch?: string;
  strictTddContext?: {
    stage: "tests" | "implementation";
    testPaths: string[];
    fastFailureOutput?: string;
  };
}): string {
  const manifestJson = JSON.stringify(args.manifest, null, 2);
  const branchLine = args.taskBranch ? `Task branch: ${args.taskBranch}` : null;
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
    `Task spec:\n${args.spec.trim()}`,
    repoNavigation,
    rules.join("\n"),
  ];

  return sections.filter((part) => Boolean(part)).join("\n\n");
}

function buildRetryPrompt(args: {
  spec: string;
  lastFailure: { type: "lint" | "doctor"; output: string };
  failedAttempt: number;
}): string {
  const failureOutput = args.lastFailure.output.trim();
  const outputLabel = args.lastFailure.type === "lint" ? "Lint output:" : "Doctor output:";
  const failureLabel = args.lastFailure.type === "lint" ? "lint command" : "doctor command";
  const outputText =
    failureOutput.length > 0
      ? failureOutput
      : `<no ${args.lastFailure.type} output captured>`;
  const guidance =
    args.lastFailure.type === "lint"
      ? "Fix the lint issues. Then re-run lint and doctor until they pass."
      : "Re-read the task spec and fix the issues. Then re-run doctor until it passes.";

  return [
    `The ${failureLabel} failed on attempt ${args.failedAttempt}.`,
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
  taskId: string;
  manifest: TaskManifest;
  manifestPath: string;
  spec: string;
  taskBranch?: string;
  codex: CodexRunnerLike;
  workerState: WorkerStateStore;
  log: WorkerLogger;
  loggedResumeEvent: boolean;
  workingDirectory: string;
  checkpointCommits: boolean;
  testPaths: string[];
  fastCommand?: string;
  doctorTimeoutSeconds?: number;
  runLogsDir: string;
  commandEnv: NodeJS.ProcessEnv;
}): Promise<{ nextAttempt: number; fastOutput: string; loggedResumeEvent: boolean }> {
  const fastCommand = args.fastCommand?.trim();
  if (!fastCommand) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "missing_fast_command" },
    });
    throw new Error("Strict TDD mode requires verify.fast to be set, but none was provided.");
  }

  if (args.testPaths.length === 0) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "missing_test_paths" },
    });
    throw new Error("Strict TDD mode requires test_paths (manifest or project defaults).");
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
    strictTddContext: { stage: "tests", testPaths: args.testPaths },
  });

  const loggedResumeEvent = await runCodexTurn({
    attempt: args.attempt,
    codex: args.codex,
    log: args.log,
    workerState: args.workerState,
    loggedResumeEvent: args.loggedResumeEvent,
    prompt,
    runLogsDir: args.runLogsDir,
  });

  const afterChanges = await listChangedPaths(args.workingDirectory);
  const newChanges = diffChangedPaths(beforeChanges, afterChanges);
  const filteredChanges = filterInternalChanges(newChanges, args.workingDirectory, args.runLogsDir);
  const nonTestChanges = filteredChanges.filter((file) => !isTestPath(file, args.testPaths));

  if (nonTestChanges.length > 0) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "non_test_changes", files: nonTestChanges },
    });
    throw new Error(
      `Strict TDD Stage A failed: changes outside test_paths detected (${nonTestChanges.join(", ")}).`,
    );
  }

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

  const fast = await runVerificationCommand({
    command: fastCommand,
    cwd: args.workingDirectory,
    timeoutSeconds: args.doctorTimeoutSeconds,
    env: args.commandEnv,
  });

  const fastOutput = fast.output.trim();
  writeRunLog(args.runLogsDir, `verify-fast-${safeAttemptName(args.attempt)}.log`, fastOutput + "\n");

  if (fast.exitCode === 0) {
    args.log.log({
      type: "tdd.stage.fail",
      attempt: args.attempt,
      payload: { stage: "A", reason: "fast_passed" },
    });
    throw new Error("Strict TDD Stage A expected verify.fast to fail, but it passed.");
  }

  args.log.log({
    type: "tdd.stage.pass",
    attempt: args.attempt,
    payload: {
      stage: "A",
      mode: "strict",
      exit_code: fast.exitCode,
      files_changed: filteredChanges.length,
    },
  });

  return {
    nextAttempt: args.attempt + 1,
    fastOutput: fastOutput.slice(0, DOCTOR_PROMPT_LIMIT),
    loggedResumeEvent,
  };
}

async function runCodexTurn(args: {
  attempt: number;
  prompt: string;
  codex: CodexRunnerLike;
  log: WorkerLogger;
  workerState: WorkerStateStore;
  loggedResumeEvent: boolean;
  runLogsDir: string;
}): Promise<boolean> {
  await args.workerState.recordAttemptStart(args.attempt);
  args.log.log({ type: "turn.start", attempt: args.attempt });

  const promptPreview = truncateText(args.prompt, PROMPT_PREVIEW_LIMIT);
  const shouldPersistPrompt = isTruthyEnv(process.env.LOG_CODEX_PROMPTS);
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
}): Promise<void> {
  const cmds = args.commands.filter((cmd) => cmd.trim().length > 0);
  if (cmds.length === 0) {
    return;
  }

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
    if (output) {
      writeRunLog(args.runLogsDir, `bootstrap-${safeAttemptName(i + 1)}.log`, output + "\n");
    }

    const stdoutPreview = truncateText(res.stdout, OUTPUT_PREVIEW_LIMIT);
    const stderrPreview = truncateText(res.stderr, OUTPUT_PREVIEW_LIMIT);

    args.log.log({
      type: res.exitCode === 0 ? "bootstrap.cmd.complete" : "bootstrap.cmd.fail",
      payload: {
        cmd,
        exit_code: res.exitCode ?? -1,
        stdout: stdoutPreview.text,
        stdout_truncated: stdoutPreview.truncated,
        stderr: stderrPreview.text,
        stderr_truncated: stderrPreview.truncated,
      },
    });

    if (res.exitCode !== 0) {
      throw new Error(`Bootstrap command failed: "${cmd}" exited with ${res.exitCode ?? -1}`);
    }
  }

  args.log.log({ type: "bootstrap.complete" });
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

async function listChangedPaths(cwd: string): Promise<string[]> {
  const status = await execa("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    stdio: "pipe",
  });

  return status.stdout
    .split("\n")
    .map((line) => line.trim())
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

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
