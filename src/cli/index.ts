import { Command } from "commander";

import type { AppContext } from "../app/context.js";
import type { ProjectConfig } from "../core/config.js";
import { loadConfigForCli } from "./config.js";

import { autopilotCommand } from "./autopilot.js";
import { cleanCommand } from "./clean.js";
import { registerControlPlaneCommand } from "./control-plane.js";
import { initCommand } from "./init.js";
import { registerLogsCommand } from "./logs.js";
import { planProject } from "./plan.js";
import { resumeCommand } from "./resume.js";
import { runCommand } from "./run.js";
import { registerRunsCommand } from "./runs.js";
import { statusCommand } from "./status.js";
import { registerTasksCommand } from "./tasks.js";
import { uiCommand } from "./ui.js";

export function buildCli(): Command {
  const program = new Command();

  const resolveConfig = async (
    projectName: string | undefined,
    explicitConfig?: string,
  ): Promise<{ appContext: AppContext; config: ProjectConfig; projectName: string }> => {
    const {
      appContext,
      config,
      configPath,
      created,
      projectName: resolvedProjectName,
    } = await loadConfigForCli({
      projectName,
      explicitConfigPath: explicitConfig,
      initIfMissing: true,
    });

    if (created) {
      console.log(`Created project config at ${configPath}`);
      console.log(`Edit ${configPath} to set doctor, resources, and models.`);
    }

    return { appContext, config, projectName: resolvedProjectName };
  };

  program
    .name("mycelium")
    .description("Mycelium task orchestrator (Codex workers + Docker isolation)")
    .version("0.1.0")
    .option(
      "--config <path>",
      "Override project config path (defaults to repo .mycelium/config.yaml or ~/.mycelium/projects/<project>.yaml)",
    )
    .option("-v, --verbose", "Verbose output", false);

  registerLogsCommand(program);
  registerControlPlaneCommand(program);
  registerRunsCommand(program);
  registerTasksCommand(program);

  program
    .command("init")
    .description("Initialize repo config and task workspace")
    .option("--force", "Overwrite existing repo config", false)
    .action(async (opts) => {
      await initCommand({ force: opts.force });
    });

  program
    .command("autopilot")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--plan-input <path>", "Path to implementation plan markdown")
    .option("--plan-output <dir>", "Tasks output directory (default: <repo>/.mycelium/tasks)")
    .option("--run-id <id>", "Run/transcript id (default: timestamp)")
    .option("--max-questions <n>", "Max interview questions", (v) => parseInt(v, 10))
    .option("--max-parallel <n>", "Max parallel containers", (v) => parseInt(v, 10))
    .option("--dry-run", "Plan batches but do not start workers", false)
    .option("--skip-run", "Stop after planning and task generation", false)
    .option("--no-build-image", "Do not auto-build the worker image if missing")
    .option(
      "--stop-containers-on-exit",
      "Stop task containers when the CLI receives SIGINT/SIGTERM",
      false,
    )
    .option(
      "--local-worker",
      "Run workers directly on the host without Docker (development/pilot)",
      false,
    )
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await autopilotCommand(
        projectName,
        config,
        {
          planInput: opts.planInput,
          planOutput: opts.planOutput,
          runId: opts.runId,
          maxQuestions: opts.maxQuestions,
          maxParallel: opts.maxParallel,
          skipRun: opts.skipRun,
          runDryRun: opts.dryRun,
          buildImage: opts.buildImage,
          useDocker: !opts.localWorker,
          stopContainersOnExit: opts.stopContainersOnExit,
        },
        appContext,
      );
    });

  program
    .command("plan")
    .option("--project <name>", "Project name (default: repo folder name)")
    .requiredOption("--input <path>", "Path to implementation-plan.md")
    .option("--output <dir>", "Tasks output directory (default: <repo>/.mycelium/tasks)")
    .option("--dry-run", "Do not write tasks; just print JSON", false)
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await planProject(
        projectName,
        config,
        {
          input: opts.input,
          output: opts.output,
          dryRun: opts.dryRun,
        },
        appContext,
      );
    });

  program
    .command("run")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--tasks <ids>", "Comma-separated task IDs to run", (v: string) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .option("--run-id <id>", "Run ID (default: timestamp)")
    .option("--reuse-completed", "Reuse completed tasks from the ledger")
    .option("--no-reuse-completed", "Disable reusing completed tasks from the ledger")
    .option("--import-run <id>", "Import completed tasks from a prior run into the ledger")
    .option("--max-parallel <n>", "Max parallel containers", (v) => parseInt(v, 10))
    .option("--dry-run", "Plan batches but do not start containers", false)
    .option("--no-build-image", "Do not auto-build the worker image if missing")
    .option("--ui", "Enable the UI server (overrides config)")
    .option("--no-ui", "Disable the UI server")
    .option("--ui-port <n>", "UI server port", (v) => parseInt(v, 10))
    .option("--ui-open", "Open the UI in a browser")
    .option("--no-ui-open", "Do not open the UI in a browser")
    .option(
      "--stop-containers-on-exit",
      "Stop task containers when the CLI receives SIGINT/SIGTERM",
      false,
    )
    .option(
      "--local-worker",
      "Run workers directly on the host without Docker (development/pilot)",
      false,
    )
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await runCommand(
        projectName,
        config,
        {
          runId: opts.runId,
          tasks: opts.tasks,
          maxParallel: opts.maxParallel,
          dryRun: opts.dryRun,
          buildImage: opts.buildImage,
          useDocker: !opts.localWorker,
          stopContainersOnExit: opts.stopContainersOnExit,
          reuseCompleted: opts.reuseCompleted,
          importRun: opts.importRun,
          ui: opts.ui,
          uiPort: opts.uiPort,
          uiOpen: opts.uiOpen,
        },
        appContext,
      );
    });

  program
    .command("resume")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--reuse-completed", "Reuse completed tasks from the ledger")
    .option("--no-reuse-completed", "Disable reusing completed tasks from the ledger")
    .option("--import-run <id>", "Import completed tasks from a prior run into the ledger")
    .option("--max-parallel <n>", "Max parallel containers", (v) => parseInt(v, 10))
    .option("--dry-run", "Plan batches but do not start containers", false)
    .option("--no-build-image", "Do not auto-build the worker image if missing")
    .option("--ui", "Enable the UI server (overrides config)")
    .option("--no-ui", "Disable the UI server")
    .option("--ui-port <n>", "UI server port", (v) => parseInt(v, 10))
    .option("--ui-open", "Open the UI in a browser")
    .option("--no-ui-open", "Do not open the UI in a browser")
    .option(
      "--stop-containers-on-exit",
      "Stop task containers when the CLI receives SIGINT/SIGTERM",
      false,
    )
    .option(
      "--local-worker",
      "Run workers directly on the host without Docker (development/pilot)",
      false,
    )
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await resumeCommand(
        projectName,
        config,
        {
          runId: opts.runId,
          maxParallel: opts.maxParallel,
          dryRun: opts.dryRun,
          buildImage: opts.buildImage,
          useDocker: !opts.localWorker,
          stopContainersOnExit: opts.stopContainersOnExit,
          reuseCompleted: opts.reuseCompleted,
          importRun: opts.importRun,
          ui: opts.ui,
          uiPort: opts.uiPort,
          uiOpen: opts.uiOpen,
        },
        appContext,
      );
    });

  program
    .command("ui")
    .description("Start the UI server for a run")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--port <n>", "UI server port", (v) => parseInt(v, 10))
    .option("--open", "Open the UI in a browser")
    .option("--no-open", "Do not open the UI in a browser")
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await uiCommand(
        projectName,
        config,
        {
          runId: opts.runId,
          port: opts.port,
          openBrowser: opts.open,
        },
        appContext,
      );
    });

  program
    .command("status")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--run-id <id>", "Run ID (default: latest)")
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await statusCommand(projectName, config, { runId: opts.runId }, appContext);
    });

  program
    .command("clean")
    .option("--project <name>", "Project name (default: repo folder name)")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--keep-logs", "Do not delete logs", false)
    .option("--dry-run", "Show cleanup targets without deleting", false)
    .option("--force", "Do not prompt before deleting", false)
    .option("--no-containers", "Skip Docker container cleanup", false)
    .action(async (opts) => {
      const globals = program.opts();
      const { appContext, config, projectName } = await resolveConfig(opts.project, globals.config);
      await cleanCommand(
        projectName,
        config,
        {
          runId: opts.runId,
          keepLogs: opts.keepLogs,
          dryRun: opts.dryRun,
          force: opts.force,
          removeContainers: opts.containers,
        },
        appContext,
      );
    });

  return program;
}
