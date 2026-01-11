import { Command } from "commander";

import { loadProjectConfig } from "../core/config-loader.js";
import { projectConfigPath } from "../core/paths.js";

import { cleanCommand } from "./clean.js";
import { logsCommand } from "./logs.js";
import { planProject } from "./plan.js";
import { resumeCommand } from "./resume.js";
import { runCommand } from "./run.js";
import { statusCommand } from "./status.js";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("task-orchestrator")
    .description("Autonomous task orchestrator (Codex workers + Docker isolation)")
    .version("0.1.0")
    .option(
      "--config <path>",
      "Override project config path (defaults to ~/.task-orchestrator/projects/<project>.yaml)",
    )
    .option("-v, --verbose", "Verbose output", false);

  program
    .command("plan")
    .requiredOption(
      "--project <name>",
      "Project name (config is resolved from ~/.task-orchestrator/projects)",
    )
    .requiredOption("--input <path>", "Path to implementation-plan.md")
    .option("--output <dir>", "Tasks output directory (default: <repo>/.tasks)")
    .option("--dry-run", "Do not write tasks; just print JSON", false)
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await planProject(opts.project, cfg, {
        input: opts.input,
        output: opts.output,
        dryRun: opts.dryRun,
      });
    });

  program
    .command("run")
    .requiredOption("--project <name>", "Project name")
    .option("--tasks <ids>", "Comma-separated task IDs to run", (v: string) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .option("--run-id <id>", "Run ID (default: timestamp)")
    .option("--max-parallel <n>", "Max parallel containers", (v) => parseInt(v, 10))
    .option("--dry-run", "Plan batches but do not start containers", false)
    .option("--no-build-image", "Do not auto-build the worker image if missing")
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await runCommand(opts.project, cfg, {
        runId: opts.runId,
        tasks: opts.tasks,
        maxParallel: opts.maxParallel,
        dryRun: opts.dryRun,
        buildImage: opts.buildImage,
      });
    });

  program
    .command("resume")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--max-parallel <n>", "Max parallel containers", (v) => parseInt(v, 10))
    .option("--dry-run", "Plan batches but do not start containers", false)
    .option("--no-build-image", "Do not auto-build the worker image if missing")
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await resumeCommand(opts.project, cfg, {
        runId: opts.runId,
        maxParallel: opts.maxParallel,
        dryRun: opts.dryRun,
        buildImage: opts.buildImage,
      });
    });

  program
    .command("status")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await statusCommand(opts.project, cfg, { runId: opts.runId });
    });

  program
    .command("logs")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--task <id>", "Task ID")
    .option("--follow", "Tail/follow logs", false)
    .option("--search <pattern>", "Search for a string")
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await logsCommand(opts.project, cfg, {
        runId: opts.runId,
        taskId: opts.task,
        follow: opts.follow,
        search: opts.search,
      });
    });

  program
    .command("clean")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--keep-logs", "Do not delete logs", false)
    .action(async (opts) => {
      const globals = program.opts();
      const configPath = globals.config ?? projectConfigPath(opts.project);
      const cfg = loadProjectConfig(configPath);
      await cleanCommand(opts.project, cfg, { runId: opts.runId, keepLogs: opts.keepLogs });
    });

  return program;
}
