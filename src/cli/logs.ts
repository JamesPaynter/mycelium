import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { loadProjectConfig } from "../core/config-loader.js";
import type { ProjectConfig } from "../core/config.js";
import {
  followJsonlFile,
  readJsonlFile,
  searchLogs,
  taskEventsLogPathForId,
  findTaskLogDir,
  type JsonlFilter,
} from "../core/log-query.js";
import { projectConfigPath, resolveRunLogsDir } from "../core/paths.js";

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description("Inspect orchestrator and task logs")
    .requiredOption("--project <name>", "Project name")
    .option("--run-id <id>", "Run ID (default: latest)")
    .option("--follow", "Follow orchestrator logs", false);

  logs
    .command("query")
    .description("Print JSONL events for orchestrator or a task")
    .option("--task <id>", "Task ID to filter")
    .option("--type <glob>", "Filter by event type (supports *)")
    .option("--follow", "Follow log output", false)
    .action(async (opts, command) => {
      const ctx = buildContext(command);
      await logsQuery(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        typeGlob: opts.type,
        follow: opts.follow ?? false,
      });
    });

  logs
    .command("search")
    .description("Search across run logs for a substring (grep-style)")
    .argument("<pattern>", "String to search for")
    .option("--task <id>", "Limit search to a specific task")
    .action(async (pattern, opts, command) => {
      const ctx = buildContext(command);
      await logsSearch(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        pattern,
        taskId: opts.task,
      });
    });

  logs
    .command("doctor")
    .description("Show raw doctor output for a task attempt")
    .requiredOption("--task <id>", "Task ID")
    .option("--attempt <n>", "Attempt number", (v: string) => parseInt(v, 10))
    .action(async (opts, command) => {
      const ctx = buildContext(command);
      await logsDoctor(ctx.projectName, ctx.config, {
        runId: ctx.runId,
        taskId: opts.task,
        attempt: opts.attempt,
      });
    });

  logs.action(async (opts, command) => {
    const ctx = buildContext(command);
    await logsQuery(ctx.projectName, ctx.config, {
      runId: ctx.runId,
      follow: opts.follow ?? false,
    });
  });
}

export async function logsQuery(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId?: string; typeGlob?: string; follow?: boolean },
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId);
  if (!runLogs) return;

  const filter: JsonlFilter = {};
  if (opts.taskId) filter.taskId = opts.taskId;
  if (opts.typeGlob) filter.typeGlob = opts.typeGlob;

  const target =
    opts.taskId === undefined
      ? path.join(runLogs.dir, "orchestrator.jsonl")
      : taskEventsLogPathForId(runLogs.dir, opts.taskId);

  if (!target) {
    console.log(`No logs found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(target)) {
    console.log(`Log file not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const lines = readJsonlFile(target, filter);
  for (const line of lines) {
    console.log(line);
  }

  if (opts.follow) {
    console.log(`\nFollowing ${target} (Ctrl+C to stop)...`);
    const stop = followJsonlFile(target, filter, (newLines) => {
      for (const line of newLines) {
        console.log(line);
      }
    });

    attachExitHandlers(stop);
    await waitIndefinitely();
  }
}

export async function logsSearch(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; pattern: string; taskId?: string },
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId);
  if (!runLogs) return;

  const matches = searchLogs(runLogs.dir, opts.pattern, { taskId: opts.taskId });
  if (matches.length === 0) {
    console.log(`No matches for "${opts.pattern}" in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  for (const match of matches) {
    const relPath = relativeToRun(runLogs.dir, match.filePath);
    console.log(`${relPath}:${match.lineNumber}:${match.line}`);
  }
}

export async function logsDoctor(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId: string; attempt?: number },
): Promise<void> {
  const runLogs = resolveRunLogsOrWarn(projectName, opts.runId);
  if (!runLogs) return;

  const taskDir = findTaskLogDir(runLogs.dir, opts.taskId);
  if (!taskDir) {
    console.log(`No logs directory found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  const doctorFiles = fs
    .readdirSync(taskDir)
    .filter((file) => /^doctor-\d+\.log$/i.test(file))
    .sort();

  if (doctorFiles.length === 0) {
    console.log(`No doctor logs found for task ${opts.taskId} in run ${runLogs.runId}.`);
    process.exitCode = 1;
    return;
  }

  if (opts.attempt !== undefined && (!Number.isInteger(opts.attempt) || opts.attempt <= 0)) {
    console.log("--attempt must be a positive integer.");
    process.exitCode = 1;
    return;
  }

  const selected = pickDoctorLog(doctorFiles, opts.attempt);
  if (!selected) {
    console.log(`Doctor log for attempt ${opts.attempt} not found for task ${opts.taskId}.`);
    process.exitCode = 1;
    return;
  }

  const attemptNum = selected.attempt;
  const fullPath = path.join(taskDir, selected.fileName);
  const content = fs.readFileSync(fullPath, "utf8");

  console.log(
    `Doctor log for task ${opts.taskId} (run ${runLogs.runId}, attempt ${attemptNum}): ${fullPath}`,
  );
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}

function buildContext(command: Command): {
  projectName: string;
  runId?: string;
  config: ProjectConfig;
} {
  const opts = command.optsWithGlobals() as { project?: string; runId?: string; config?: string };
  if (!opts.project) {
    throw new Error("Project name is required");
  }

  const configPath = opts.config ?? projectConfigPath(opts.project);
  const config = loadProjectConfig(configPath);

  return { projectName: opts.project, runId: opts.runId, config };
}

function resolveRunLogsOrWarn(
  projectName: string,
  runId?: string,
): { runId: string; dir: string } | null {
  const resolved = resolveRunLogsDir(projectName, runId);
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

function pickDoctorLog(
  files: string[],
  attempt?: number,
): { attempt: number; fileName: string } | null {
  const parsed = files
    .map((file) => {
      const match = file.match(/^doctor-(\d+)\.log$/i);
      return match ? { fileName: file, attempt: Number.parseInt(match[1], 10) } : null;
    })
    .filter(Boolean) as { attempt: number; fileName: string }[];

  if (parsed.length === 0) return null;

  if (attempt !== undefined) {
    return parsed.find((item) => item.attempt === attempt) ?? null;
  }

  return parsed.sort((a, b) => b.attempt - a.attempt)[0];
}

function relativeToRun(baseDir: string, targetPath: string): string {
  const relative = path.relative(baseDir, targetPath);
  return relative.startsWith("..") ? targetPath : relative;
}

function attachExitHandlers(cleanup: () => void): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.once(signal, () => {
      cleanup();
      process.exit();
    });
  }
}

function waitIndefinitely(): Promise<void> {
  return new Promise(() => undefined);
}
