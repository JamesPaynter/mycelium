import path from "node:path";

import type { WorkerConfig } from "./loop.js";

// =============================================================================
// TYPES
// =============================================================================

export type CliOptions = {
  taskId?: string;
  taskSlug?: string;
  taskBranch?: string;
  taskDir?: string;
  manifest?: string;
  spec?: string;
  lint?: string;
  lintTimeout?: number;
  doctor?: string;
  maxRetries?: number;
  doctorTimeout?: number;
  bootstrap?: string[];
  defaultTestPaths?: string[];
  runLogsDir?: string;
  codexHome?: string;
  codexModel?: string;
  workdir?: string;
  checkpointCommits?: boolean;
  logCodexPrompts?: boolean;
};

// =============================================================================
// CONFIG BUILDING
// =============================================================================

export function buildConfig(opts: CliOptions): WorkerConfig {
  const workingDirectory = resolveWorkingDirectory(opts);
  const taskId = requireTaskId(opts);
  const { taskSlug, taskBranch, taskDir } = resolveTaskMetadata(opts, workingDirectory);
  const { manifestPath, specPath } = resolveTaskPaths(opts, workingDirectory, taskDir);
  const doctorCmd = requireDoctorCmd(opts);
  const lintCmd = resolveLintCmd(opts);
  const maxRetries = resolveMaxRetries(opts);
  const { lintTimeoutSeconds, doctorTimeoutSeconds } = resolveTimeoutSettings(opts);
  const bootstrapCmds = resolveBootstrapCommands(opts);
  const defaultTestPaths = resolveDefaultTestPaths(opts);
  const runLogsDir = resolveRunLogsDir(opts, workingDirectory);
  const codexHome = resolveCodexHome(opts, workingDirectory);
  const checkpointCommits = resolveCheckpointCommits(opts);

  return {
    taskId,
    taskSlug,
    taskBranch,
    specPath,
    manifestPath,
    lintCmd,
    lintTimeoutSeconds,
    doctorCmd,
    doctorTimeoutSeconds,
    maxRetries,
    bootstrapCmds,
    defaultTestPaths,
    runLogsDir,
    codexHome,
    codexModel: resolveCodexModel(opts),
    workingDirectory,
    checkpointCommits,
    logCodexPrompts: resolveBooleanEnv("LOG_CODEX_PROMPTS"),
  };
}

// =============================================================================
// RESOLUTION HELPERS
// =============================================================================

function resolveWorkingDirectory(opts: CliOptions): string {
  return resolvePath(opts.workdir ?? process.cwd(), process.cwd());
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireTaskId(opts: CliOptions): string {
  const taskId = normalizeOptionalString(opts.taskId ?? envOrUndefined("TASK_ID"));
  if (!taskId) {
    throw new Error("TASK_ID is required (set TASK_ID or pass --task-id).");
  }
  return taskId;
}

function resolveTaskMetadata(
  opts: CliOptions,
  workingDirectory: string,
): { taskSlug?: string; taskBranch?: string; taskDir?: string } {
  return {
    taskSlug: normalizeOptionalString(opts.taskSlug ?? envOrUndefined("TASK_SLUG")),
    taskBranch: normalizeOptionalString(opts.taskBranch ?? envOrUndefined("TASK_BRANCH")),
    taskDir: resolveOptionalPath(opts.taskDir ?? envOrUndefined("TASK_DIR"), workingDirectory),
  };
}

function resolveTaskPaths(
  opts: CliOptions,
  workingDirectory: string,
  taskDir?: string,
): { manifestPath: string; specPath: string } {
  const manifestPath = resolveRequiredPath(
    opts.manifest ??
      envOrUndefined("TASK_MANIFEST_PATH") ??
      (taskDir ? path.join(taskDir, "manifest.json") : undefined),
    workingDirectory,
    "TASK_MANIFEST_PATH or --manifest (or set --task-dir)",
  );

  const specPath = resolveRequiredPath(
    opts.spec ??
      envOrUndefined("TASK_SPEC_PATH") ??
      (taskDir ? path.join(taskDir, "spec.md") : undefined),
    workingDirectory,
    "TASK_SPEC_PATH or --spec (or set --task-dir)",
  );

  return { manifestPath, specPath };
}

function requireDoctorCmd(opts: CliOptions): string {
  const doctorCmd = normalizeOptionalString(opts.doctor ?? envOrUndefined("DOCTOR_CMD"));
  if (!doctorCmd) {
    throw new Error("DOCTOR_CMD is required (set DOCTOR_CMD or pass --doctor).");
  }
  return doctorCmd;
}

function resolveLintCmd(opts: CliOptions): string | undefined {
  return normalizeOptionalString(opts.lint ?? envOrUndefined("LINT_CMD"));
}

function resolveMaxRetries(opts: CliOptions): number {
  const maxRetries =
    getIntOption(opts.maxRetries, envOrUndefined("MAX_RETRIES"), "MAX_RETRIES") ?? 20;
  if (maxRetries < 0) {
    throw new Error("MAX_RETRIES must be a non-negative integer.");
  }
  return maxRetries;
}

function resolveTimeoutSettings(opts: CliOptions): {
  lintTimeoutSeconds: number | undefined;
  doctorTimeoutSeconds: number | undefined;
} {
  return {
    lintTimeoutSeconds: getIntOption(
      opts.lintTimeout,
      envOrUndefined("LINT_TIMEOUT"),
      "LINT_TIMEOUT",
    ),
    doctorTimeoutSeconds: getIntOption(
      opts.doctorTimeout,
      envOrUndefined("DOCTOR_TIMEOUT"),
      "DOCTOR_TIMEOUT",
    ),
  };
}

function resolveBootstrapCommands(opts: CliOptions): string[] {
  return opts.bootstrap ?? parseBootstrap(envOrUndefined("BOOTSTRAP_CMDS"));
}

function resolveDefaultTestPaths(opts: CliOptions): string[] | undefined {
  return (
    opts.defaultTestPaths ??
    parseStringArray(envOrUndefined("DEFAULT_TEST_PATHS"), "DEFAULT_TEST_PATHS")
  );
}

function resolveRunLogsDir(opts: CliOptions, workingDirectory: string): string {
  return resolvePath(
    opts.runLogsDir ?? envOrUndefined("RUN_LOGS_DIR") ?? "/run-logs",
    workingDirectory,
  );
}

function resolveCodexHome(opts: CliOptions, workingDirectory: string): string {
  return resolvePath(
    opts.codexHome ??
      envOrUndefined("CODEX_HOME") ??
      path.join(workingDirectory, ".mycelium", "codex-home"),
    workingDirectory,
  );
}

function resolveCheckpointCommits(opts: CliOptions): boolean {
  return (
    getBooleanOption(
      opts.checkpointCommits,
      envOrUndefined("CHECKPOINT_COMMITS"),
      "CHECKPOINT_COMMITS",
    ) ?? true
  );
}

function resolveCodexModel(opts: CliOptions): string | undefined {
  return opts.codexModel ?? envOrUndefined("CODEX_MODEL") ?? undefined;
}

// =============================================================================
// OPTION PARSING
// =============================================================================

function getIntOption(
  cliValue: number | undefined,
  envValue: string | undefined,
  label: string,
): number | undefined {
  if (cliValue !== undefined) {
    if (!Number.isInteger(cliValue)) {
      throw new Error(`${label} must be an integer.`);
    }
    return cliValue;
  }
  if (envValue !== undefined) {
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${label} must be an integer.`);
    }
    return parsed;
  }
  return undefined;
}

function getBooleanOption(
  cliValue: boolean | undefined,
  envValue: string | undefined,
  label: string,
): boolean | undefined {
  if (cliValue !== undefined) return cliValue;
  if (envValue !== undefined) return parseBoolean(envValue, label);
  return undefined;
}

export function parseBoolean(value: string, label: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false.`);
}

function resolveBooleanEnv(name: string): boolean | undefined {
  const raw = envOrUndefined(name);
  if (raw === undefined) return undefined;
  return parseBoolean(raw, name);
}

function parseBootstrap(raw: string | undefined): string[] {
  return parseStringArray(raw, "BOOTSTRAP_CMDS") ?? [];
}

function parseStringArray(raw: string | undefined, label: string): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // handled below
  }
  throw new Error(`${label} must be a JSON array of strings.`);
}

function resolvePath(input: string, baseDir: string): string {
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input);
}

function resolveOptionalPath(input: string | undefined, baseDir: string): string | undefined {
  if (!input) return undefined;
  return resolvePath(input, baseDir);
}

function resolveRequiredPath(input: string | undefined, baseDir: string, label: string): string {
  if (!input) {
    throw new Error(`Missing required path: ${label}.`);
  }
  return resolvePath(input, baseDir);
}

function envOrUndefined(name: string): string | undefined {
  return process.env[name];
}
