import fs from "node:fs/promises";
import path from "node:path";

import { execa, execaCommand } from "execa";

import { CodexRunner } from "./codex.js";
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
  verify?: { doctor?: string; fast?: string };
  [key: string]: unknown;
};

export type WorkerConfig = {
  taskId: string;
  taskSlug?: string;
  taskBranch?: string;
  specPath: string;
  manifestPath: string;
  doctorCmd: string;
  doctorTimeoutSeconds?: number;
  maxRetries: number;
  bootstrapCmds: string[];
  runLogsDir: string;
  codexHome: string;
  codexModel?: string;
  workingDirectory: string;
};

const DOCTOR_PROMPT_LIMIT = 12_000;
const OUTPUT_PREVIEW_LIMIT = 4_000;

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

  const startingAttempt = workerState.nextAttempt;
  if (startingAttempt > config.maxRetries) {
    throw new Error(
      `No attempts remaining: next attempt ${startingAttempt} exceeds max retries ${config.maxRetries}`,
    );
  }

  const codex = new CodexRunner({
    codexHome: config.codexHome,
    model: config.codexModel,
    workingDirectory: config.workingDirectory,
    threadId: workerState.threadId,
  });

  let lastDoctorOutput = "";
  let loggedResumeEvent = false;

  for (let attempt = startingAttempt; attempt <= config.maxRetries; attempt += 1) {
    await workerState.recordAttemptStart(attempt);
    log.log({ type: "turn.start", attempt });

    const prompt =
      attempt === 1
        ? buildInitialPrompt({
            spec,
            manifest,
            manifestPath: config.manifestPath,
            taskBranch: config.taskBranch,
          })
        : buildRetryPrompt({ spec, lastDoctorOutput, attempt });

    await codex.streamPrompt(prompt, {
      onThreadResumed: (threadId) => {
        if (!loggedResumeEvent) {
          log.log({
            type: "codex.thread.resumed",
            attempt,
            payload: { thread_id: threadId },
          });
          loggedResumeEvent = true;
        }
      },
      onThreadStarted: async (threadId) => {
        await workerState.recordThreadId(threadId);
        log.log({
          type: "codex.thread.started",
          attempt,
          payload: { thread_id: threadId },
        });
      },
      onEvent: (event) =>
        log.log({
          type: "codex.event",
          attempt,
          payload: { event } as JsonObject,
        }),
    });

    log.log({ type: "turn.complete", attempt });

    const doctorPayload: JsonObject = { command: config.doctorCmd };
    if (config.doctorTimeoutSeconds !== undefined) {
      doctorPayload.timeout_seconds = config.doctorTimeoutSeconds;
    }

    log.log({ type: "doctor.start", attempt, payload: doctorPayload });

    const doctor = await runDoctor({
      command: config.doctorCmd,
      cwd: config.workingDirectory,
      timeoutSeconds: config.doctorTimeoutSeconds,
      env: commandEnv,
    });

    const doctorOutput = doctor.output.trim();
    writeRunLog(config.runLogsDir, `doctor-${safeAttemptName(attempt)}.log`, doctorOutput + "\n");

    if (doctor.exitCode === 0) {
      log.log({ type: "doctor.pass", attempt });
      await maybeCommit({
        cwd: config.workingDirectory,
        manifest,
        taskId: config.taskId,
        log,
      });
      log.log({ type: "task.complete", attempt });
      return;
    }

    lastDoctorOutput = doctorOutput.slice(0, DOCTOR_PROMPT_LIMIT);
    log.log({
      type: "doctor.fail",
      attempt,
      payload: {
        exit_code: doctor.exitCode,
        summary: lastDoctorOutput.slice(0, 500),
      },
    });

    if (attempt < config.maxRetries) {
      log.log({ type: "task.retry", attempt: attempt + 1 });
    }
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
}): string {
  const manifestJson = JSON.stringify(args.manifest, null, 2);
  const branchLine = args.taskBranch ? `Task branch: ${args.taskBranch}` : null;

  const sections = [
    "You are a coding agent working in a git repository.",
    `Task manifest (${args.manifestPath}):\n${manifestJson}`,
    branchLine,
    `Task spec:\n${args.spec.trim()}`,
    [
      "Rules:",
      "- Prefer test-driven development: add/adjust tests first, confirm they fail for the right reason, then implement.",
      "- Keep changes minimal and aligned with existing patterns.",
      "- Run the provided verification commands in the spec and ensure the doctor command passes.",
      "- If doctor fails, iterate until it passes.",
    ].join("\n"),
  ];

  return sections.filter((part) => Boolean(part)).join("\n\n");
}

function buildRetryPrompt(args: { spec: string; lastDoctorOutput: string; attempt: number }): string {
  const doctorText = args.lastDoctorOutput.trim() || "<no doctor output captured>";
  return [
    `The doctor command failed on attempt ${args.attempt}.`,
    "",
    "Doctor output:",
    doctorText,
    "",
    "Re-read the task spec and fix the issues. Then re-run doctor until it passes.",
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

async function runDoctor(args: {
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

async function ensureGitIdentity(cwd: string, log: WorkerLogger): Promise<void> {
  const nameRes = await execa("git", ["config", "--get", "user.name"], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  if (nameRes.exitCode !== 0 || nameRes.stdout.trim().length === 0) {
    await execa("git", ["config", "user.name", "task-orchestrator"], { cwd });
    log.log({ type: "git.identity.set", payload: { field: "user.name" } });
  }

  const emailRes = await execa("git", ["config", "--get", "user.email"], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  if (emailRes.exitCode !== 0 || emailRes.stdout.trim().length === 0) {
    await execa("git", ["config", "user.email", "task-orchestrator@localhost"], { cwd });
    log.log({ type: "git.identity.set", payload: { field: "user.email" } });
  }
}

async function maybeCommit(args: {
  cwd: string;
  manifest: TaskManifest;
  taskId: string;
  log: WorkerLogger;
}): Promise<void> {
  const status = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });
  if (status.stdout.trim().length === 0) {
    args.log.log({ type: "git.commit.skip", payload: { reason: "no_changes" } });
    return;
  }

  await execa("git", ["add", "-A"], { cwd: args.cwd });

  const taskName =
    typeof args.manifest.name === "string" && args.manifest.name.trim().length > 0
      ? args.manifest.name
      : args.taskId;
  const message = `[FEAT] ${args.taskId} ${taskName}\n\nTask: ${args.taskId}`;
  const commit = await execa("git", ["commit", "-m", message], {
    cwd: args.cwd,
    reject: false,
    stdio: "pipe",
  });

  if (commit.exitCode === 0) {
    const sha = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: args.cwd, stdio: "pipe" })
    ).stdout.trim();
    args.log.log({ type: "git.commit", payload: { sha } });
    return;
  }

  const statusAfter = await execa("git", ["status", "--porcelain"], {
    cwd: args.cwd,
    stdio: "pipe",
  });
  if (statusAfter.stdout.trim().length === 0) {
    args.log.log({ type: "git.commit.skip", payload: { reason: "nothing_to_commit" } });
    return;
  }

  throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
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
