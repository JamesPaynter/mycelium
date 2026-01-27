import { Command } from "commander";

import { LogQueryService } from "../../../app/services/log-query-service.js";
import type { ProjectConfig } from "../../../core/config.js";
import type { PathsContext } from "../../../core/paths.js";
import { resolveRunLogsDir } from "../../../core/paths.js";
import { loadConfigForCli } from "../../config.js";

import {
  runLogsDoctorCommand,
  runLogsFailuresCommand,
  runLogsSummarizeCommand,
} from "./handlers.js";
import { registerLogsQueryCommand, runLogsFollow, runLogsQuery } from "./query.js";
import { registerLogsSearchCommand } from "./search.js";
import { registerLogsTimelineCommand } from "./timeline.js";

// =============================================================================
// TYPES
// =============================================================================

export type LogsCommandContext = {
  projectName: string;
  runId?: string;
  config: ProjectConfig;
  useIndex: boolean;
  paths: PathsContext;
  logQueryService: LogQueryService;
  resolveRunLogsOrWarn: (runId?: string) => { runId: string; dir: string } | null;
};

export type LogsCommandContextBuilder = (command: Command) => Promise<LogsCommandContext>;

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description("Inspect orchestrator and task logs")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--use-index", "Query logs via SQLite index (builds if missing)", false)
    .option("--follow", "Follow orchestrator + task logs", false);

  const buildContext: LogsCommandContextBuilder = (command) => buildLogsCommandContext(command);

  registerLogsQueryCommand(logs, buildContext);
  registerLogsSearchCommand(logs, buildContext);
  registerLogsTimelineCommand(logs, buildContext);

  logs
    .command("failures")
    .description("Summarize failures for a run")
    .option("--task <id>", "Limit to a specific task")
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await runLogsFailuresCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
      });
    });

  logs
    .command("doctor")
    .description("Show raw doctor output for a task attempt")
    .requiredOption("--task <id>", "Task ID")
    .option("--attempt <n>", "Attempt number", (v: string) => parseInt(v, 10))
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await runLogsDoctorCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
        attempt: opts.attempt,
      });
    });

  logs
    .command("summarize")
    .description("Summarize validator results for a task")
    .requiredOption("--task <id>", "Task ID")
    .option("--llm", "Use LLM to summarize validator failures", false)
    .action(async (opts, command) => {
      const ctx = await buildContext(command);
      await runLogsSummarizeCommand(ctx, {
        runId: ctx.runId,
        taskId: opts.task,
        useLlm: opts.llm ?? false,
      });
    });

  logs.action(async (opts, command) => {
    const ctx = await buildContext(command);
    if (opts.follow) {
      await runLogsFollow(ctx, { runId: ctx.runId });
      return;
    }
    await runLogsQuery(ctx, {
      runId: ctx.runId,
      useIndex: ctx.useIndex,
    });
  });
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function buildLogsCommandContext(command: Command): Promise<LogsCommandContext> {
  const opts = command.optsWithGlobals() as {
    project?: string;
    runId?: string;
    config?: string;
    useIndex?: boolean;
  };
  if (!opts.project) {
    throw new Error("Project name is required");
  }

  const { appContext, config, projectName } = await loadConfigForCli({
    projectName: opts.project,
    explicitConfigPath: opts.config,
    initIfMissing: false,
  });

  return {
    projectName,
    runId: opts.runId,
    config,
    useIndex: opts.useIndex ?? false,
    paths: appContext.paths,
    logQueryService: new LogQueryService(config),
    resolveRunLogsOrWarn: (runId?: string) =>
      resolveRunLogsOrWarn(projectName, runId, appContext.paths),
  };
}

function resolveRunLogsOrWarn(
  projectName: string,
  runId?: string,
  paths?: PathsContext,
): { runId: string; dir: string } | null {
  const resolved = resolveRunLogsDir(projectName, runId, paths);
  if (resolved) {
    return resolved;
  }

  const message = runId
    ? `Run ${runId} not found for project ${projectName}.`
    : `No runs found for project ${projectName}.`;
  console.log(message);
  process.exitCode = 1;
  return null;
}
