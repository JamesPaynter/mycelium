import path from "node:path";

import { Command } from "commander";

import { createStdoutLogger, toErrorMessage } from "./logging.js";
import { runWorker, type WorkerConfig } from "./loop.js";

// =============================================================================
// CLI
// =============================================================================

type CliOptions = {
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

export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("task-worker")
    .description("Codex worker loop for a single task")
    .option("--task-id <id>", "Task ID (env: TASK_ID)")
    .option("--task-slug <slug>", "Task slug (env: TASK_SLUG)")
    .option("--task-branch <name>", "Task branch (env: TASK_BRANCH)")
    .option(
      "--task-dir <path>",
      "Directory containing manifest.json and spec.md (env: TASK_DIR; overrides defaults when spec/manifest paths are not provided)",
    )
    .option("--manifest <path>", "Path to manifest.json (env: TASK_MANIFEST_PATH)")
    .option("--spec <path>", "Path to spec.md (env: TASK_SPEC_PATH)")
    .option("--lint <cmd>", "Lint command to run before doctor (env: LINT_CMD)")
    .option("--lint-timeout <seconds>", "Lint timeout in seconds (env: LINT_TIMEOUT)", (v) =>
      parseInt(v, 10),
    )
    .option("--doctor <cmd>", "Doctor command to run (env: DOCTOR_CMD)")
    .option(
      "--max-retries <n>",
      "Maximum Codex attempts before failing (env: MAX_RETRIES, default 20; 0 = unlimited)",
      (v) => parseInt(v, 10),
    )
    .option("--doctor-timeout <seconds>", "Doctor timeout in seconds (env: DOCTOR_TIMEOUT)", (v) =>
      parseInt(v, 10),
    )
    .option("--bootstrap <cmd...>", "Bootstrap commands to run before Codex (env: BOOTSTRAP_CMDS)")
    .option(
      "--default-test-paths <path...>",
      "Default test path globs when the manifest omits test_paths (env: DEFAULT_TEST_PATHS)",
    )
    .option(
      "--checkpoint-commits <true|false>",
      "Enable periodic checkpoint commits (env: CHECKPOINT_COMMITS, default true)",
      (v) => parseBoolean(v, "CHECKPOINT_COMMITS"),
    )
    .option(
      "--run-logs-dir <path>",
      "Directory for doctor/bootstrap logs (env: RUN_LOGS_DIR, default: /run-logs)",
    )
    .option(
      "--codex-home <path>",
      "CODEX_HOME path for Codex SDK (env: CODEX_HOME, default: <workdir>/.mycelium/codex-home)",
    )
    .option("--codex-model <name>", "Model override for Codex (env: CODEX_MODEL)")
    .option("--workdir <path>", "Working directory for commands (default: current directory)")
    .action(async (opts: CliOptions) => {
      let config: WorkerConfig;
      try {
        config = buildConfig(opts);
      } catch (err) {
        const logger = createStdoutLogger();
        logger.log({ type: "worker.fatal", payload: { error: toErrorMessage(err) } });
        process.exit(1);
        return;
      }

      const logger = createStdoutLogger({ taskId: config.taskId, taskSlug: config.taskSlug });

      try {
        await runWorker(config, logger);
      } catch (err) {
        logger.log({ type: "worker.fatal", payload: { error: toErrorMessage(err) } });
        process.exit(1);
      }
    });

  await program.parseAsync(argv);
}

// =============================================================================
// CONFIG PARSING
// =============================================================================

function buildConfig(opts: CliOptions): WorkerConfig {
  const workingDirectory = resolvePath(opts.workdir ?? process.cwd(), process.cwd());

  const taskId = (opts.taskId ?? envOrUndefined("TASK_ID"))?.trim();
  if (!taskId) {
    throw new Error("TASK_ID is required (set TASK_ID or pass --task-id).");
  }

  const taskSlug = (opts.taskSlug ?? envOrUndefined("TASK_SLUG"))?.trim() || undefined;
  const taskBranch = (opts.taskBranch ?? envOrUndefined("TASK_BRANCH"))?.trim() || undefined;

  const taskDir = resolveOptionalPath(opts.taskDir ?? envOrUndefined("TASK_DIR"), workingDirectory);

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

  const doctorCmd = (opts.doctor ?? envOrUndefined("DOCTOR_CMD"))?.trim();
  if (!doctorCmd) {
    throw new Error("DOCTOR_CMD is required (set DOCTOR_CMD or pass --doctor).");
  }

  const lintCmd = (opts.lint ?? envOrUndefined("LINT_CMD"))?.trim() || undefined;

  const maxRetries =
    getIntOption(opts.maxRetries, envOrUndefined("MAX_RETRIES"), "MAX_RETRIES") ?? 20;
  if (maxRetries < 0) {
    throw new Error("MAX_RETRIES must be a non-negative integer.");
  }

  const lintTimeoutSeconds = getIntOption(
    opts.lintTimeout,
    envOrUndefined("LINT_TIMEOUT"),
    "LINT_TIMEOUT",
  );

  const doctorTimeoutSeconds = getIntOption(
    opts.doctorTimeout,
    envOrUndefined("DOCTOR_TIMEOUT"),
    "DOCTOR_TIMEOUT",
  );

  const bootstrapCmds = opts.bootstrap ?? parseBootstrap(envOrUndefined("BOOTSTRAP_CMDS"));
  const defaultTestPaths =
    opts.defaultTestPaths ??
    parseStringArray(envOrUndefined("DEFAULT_TEST_PATHS"), "DEFAULT_TEST_PATHS");

  const runLogsDir = resolvePath(
    opts.runLogsDir ?? envOrUndefined("RUN_LOGS_DIR") ?? "/run-logs",
    workingDirectory,
  );
  const codexHome = resolvePath(
    opts.codexHome ??
      envOrUndefined("CODEX_HOME") ??
      path.join(workingDirectory, ".mycelium", "codex-home"),
    workingDirectory,
  );
  const checkpointCommits =
    getBooleanOption(
      opts.checkpointCommits,
      envOrUndefined("CHECKPOINT_COMMITS"),
      "CHECKPOINT_COMMITS",
    ) ?? true;

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
    codexModel: opts.codexModel ?? envOrUndefined("CODEX_MODEL") ?? undefined,
    workingDirectory,
    checkpointCommits,
    logCodexPrompts: resolveBooleanEnv("LOG_CODEX_PROMPTS"),
  };
}

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

function parseBoolean(value: string, label: string): boolean {
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

// Allow direct execution via `node dist/worker/index.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv);
}
