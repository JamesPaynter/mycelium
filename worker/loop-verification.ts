import type {
  BootstrapCommandSummary,
  CommandSummary,
  PromptKind,
  RetryReason,
} from "./attempt-summary.js";
import {
  safeAttemptName,
  toErrorMessage,
  writeRunLog,
  type JsonObject,
  type WorkerLogger,
} from "./logging.js";
import { DOCTOR_PROMPT_LIMIT } from "./loop-constants.js";
import { runVerificationCommand } from "./loop-io.js";
import {
  buildCommandSummary,
  buildCommandsSummary,
  recordAttemptSummary,
} from "./loop-reporting.js";

// =============================================================================
// VERIFICATION STEPS
// =============================================================================

export type LintStepResult =
  | { status: "skipped" }
  | { status: "pass"; summary: CommandSummary }
  | {
      status: "retry";
      summary: CommandSummary;
      lastFailure: { type: "lint" | "command"; output: string };
      promptSummary: string;
    };

export type DoctorStepResult =
  | { status: "pass"; summary: CommandSummary; promptSummary: string }
  | {
      status: "retry";
      summary: CommandSummary;
      lastFailure: { type: "doctor" | "command"; output: string };
      promptSummary: string;
    };

export async function runLintStep(args: {
  attempt: number;
  lintCommand?: string;
  lintTimeoutSeconds?: number;
  commandEnv: NodeJS.ProcessEnv;
  runLogsDir: string;
  workingDirectory: string;
  log: WorkerLogger;
  promptKind: PromptKind;
  declaredWriteGlobs: string[];
  bootstrap?: BootstrapCommandSummary[];
}): Promise<LintStepResult> {
  if (!args.lintCommand) {
    return { status: "skipped" };
  }

  const lintPayload: JsonObject = { command: args.lintCommand };
  if (args.lintTimeoutSeconds !== undefined) {
    lintPayload.timeout_seconds = args.lintTimeoutSeconds;
  }

  args.log.log({ type: "lint.start", attempt: args.attempt, payload: lintPayload });

  let lintOutput = "";
  let lintExitCode = -1;
  let lintError: unknown = null;
  try {
    const lint = await runVerificationCommand({
      command: args.lintCommand,
      cwd: args.workingDirectory,
      timeoutSeconds: args.lintTimeoutSeconds,
      env: args.commandEnv,
    });
    lintOutput = lint.output.trim();
    lintExitCode = lint.exitCode;
  } catch (err) {
    lintError = err;
    lintOutput = toErrorMessage(err);
  }

  const lintLogFile = lintError
    ? `lint-error-${safeAttemptName(args.attempt)}.log`
    : `lint-attempt-${safeAttemptName(args.attempt)}.log`;
  writeRunLog(args.runLogsDir, lintLogFile, lintOutput + "\n");

  const lintSummary = buildCommandSummary({
    command: args.lintCommand,
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
      attempt: args.attempt,
      phase: "implementation",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      commands: buildCommandsSummary({ bootstrap: args.bootstrap, lint: lintSummary }),
    });

    args.log.log({
      type: "lint.fail",
      attempt: args.attempt,
      payload: { exit_code: lintExitCode, summary: lintOutput.slice(0, 500) },
    });

    return {
      status: "retry",
      summary: lintSummary,
      lastFailure: { type: "command", output: lintOutput.slice(0, DOCTOR_PROMPT_LIMIT) },
      promptSummary: summaryResult.promptSummary,
    };
  }

  if (lintExitCode === 0) {
    args.log.log({ type: "lint.pass", attempt: args.attempt });
    return { status: "pass", summary: lintSummary };
  }

  const lintPromptOutput = lintOutput.slice(0, DOCTOR_PROMPT_LIMIT);
  const retryReason: RetryReason = {
    reason_code: "lint_failed",
    human_readable_reason: "Lint failed. Fix lint issues before continuing.",
    evidence_paths: [lintLogFile],
  };

  args.log.log({
    type: "lint.fail",
    attempt: args.attempt,
    payload: {
      exit_code: lintExitCode,
      summary: lintPromptOutput.slice(0, 500),
    },
  });

  const summaryResult = await recordAttemptSummary({
    attempt: args.attempt,
    phase: "implementation",
    promptKind: args.promptKind,
    declaredWriteGlobs: args.declaredWriteGlobs,
    runLogsDir: args.runLogsDir,
    workingDirectory: args.workingDirectory,
    log: args.log,
    retry: retryReason,
    commands: buildCommandsSummary({ bootstrap: args.bootstrap, lint: lintSummary }),
  });

  return {
    status: "retry",
    summary: lintSummary,
    lastFailure: { type: "lint", output: lintPromptOutput },
    promptSummary: summaryResult.promptSummary,
  };
}

export async function runDoctorStep(args: {
  attempt: number;
  doctorCommand: string;
  doctorTimeoutSeconds?: number;
  commandEnv: NodeJS.ProcessEnv;
  runLogsDir: string;
  workingDirectory: string;
  log: WorkerLogger;
  promptKind: PromptKind;
  declaredWriteGlobs: string[];
  strictTddEnabled: boolean;
  bootstrap?: BootstrapCommandSummary[];
  lintSummary?: CommandSummary;
}): Promise<DoctorStepResult> {
  const doctorPayload: JsonObject = { command: args.doctorCommand };
  if (args.doctorTimeoutSeconds !== undefined) {
    doctorPayload.timeout_seconds = args.doctorTimeoutSeconds;
  }

  args.log.log({ type: "doctor.start", attempt: args.attempt, payload: doctorPayload });

  let doctorOutput = "";
  let doctorExitCode = -1;
  let doctorError: unknown = null;
  try {
    const doctor = await runVerificationCommand({
      command: args.doctorCommand,
      cwd: args.workingDirectory,
      timeoutSeconds: args.doctorTimeoutSeconds,
      env: args.commandEnv,
    });
    doctorOutput = doctor.output.trim();
    doctorExitCode = doctor.exitCode;
  } catch (err) {
    doctorError = err;
    doctorOutput = toErrorMessage(err);
  }

  const doctorLogFile = doctorError
    ? `doctor-error-${safeAttemptName(args.attempt)}.log`
    : `doctor-${safeAttemptName(args.attempt)}.log`;
  writeRunLog(args.runLogsDir, doctorLogFile, doctorOutput + "\n");

  const doctorSummary = buildCommandSummary({
    command: args.doctorCommand,
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
      attempt: args.attempt,
      phase: "implementation",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      retry: retryReason,
      commands: buildCommandsSummary({
        bootstrap: args.bootstrap,
        lint: args.lintSummary,
        doctor: doctorSummary,
      }),
    });

    args.log.log({
      type: "doctor.fail",
      attempt: args.attempt,
      payload: { exit_code: doctorExitCode, summary: doctorOutput.slice(0, 500) },
    });

    return {
      status: "retry",
      summary: doctorSummary,
      lastFailure: { type: "command", output: doctorOutput.slice(0, DOCTOR_PROMPT_LIMIT) },
      promptSummary: summaryResult.promptSummary,
    };
  }

  if (doctorExitCode === 0) {
    args.log.log({ type: "doctor.pass", attempt: args.attempt });
    if (args.strictTddEnabled) {
      args.log.log({
        type: "tdd.stage.pass",
        attempt: args.attempt,
        payload: { stage: "B", mode: "strict" },
      });
    }
    const summaryResult = await recordAttemptSummary({
      attempt: args.attempt,
      phase: "implementation",
      promptKind: args.promptKind,
      declaredWriteGlobs: args.declaredWriteGlobs,
      runLogsDir: args.runLogsDir,
      workingDirectory: args.workingDirectory,
      log: args.log,
      commands: buildCommandsSummary({
        bootstrap: args.bootstrap,
        lint: args.lintSummary,
        doctor: doctorSummary,
      }),
    });

    return {
      status: "pass",
      summary: doctorSummary,
      promptSummary: summaryResult.promptSummary,
    };
  }

  const retryReason: RetryReason = {
    reason_code: "doctor_failed",
    human_readable_reason: "Doctor failed. Fix issues and retry.",
    evidence_paths: [doctorLogFile],
  };

  args.log.log({
    type: "doctor.fail",
    attempt: args.attempt,
    payload: {
      exit_code: doctorExitCode,
      summary: doctorOutput.slice(0, 500),
    },
  });

  const summaryResult = await recordAttemptSummary({
    attempt: args.attempt,
    phase: "implementation",
    promptKind: args.promptKind,
    declaredWriteGlobs: args.declaredWriteGlobs,
    runLogsDir: args.runLogsDir,
    workingDirectory: args.workingDirectory,
    log: args.log,
    retry: retryReason,
    commands: buildCommandsSummary({
      bootstrap: args.bootstrap,
      lint: args.lintSummary,
      doctor: doctorSummary,
    }),
  });

  return {
    status: "retry",
    summary: doctorSummary,
    lastFailure: { type: "doctor", output: doctorOutput.slice(0, DOCTOR_PROMPT_LIMIT) },
    promptSummary: summaryResult.promptSummary,
  };
}
