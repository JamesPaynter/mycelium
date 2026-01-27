import { Command } from "commander";

import { buildConfig, parseBoolean, type CliOptions } from "./config.js";
import { createStdoutLogger, toErrorMessage } from "./logging.js";
import { runWorker } from "./loop.js";

// =============================================================================
// CLI
// =============================================================================

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
      let config: ReturnType<typeof buildConfig>;
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

// Allow direct execution via `node dist/worker/index.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv);
}
