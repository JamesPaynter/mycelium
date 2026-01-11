import os from "node:os";
import path from "node:path";

export function orchestratorHome(): string {
  return process.env.TASK_ORCHESTRATOR_HOME
    ? path.resolve(process.env.TASK_ORCHESTRATOR_HOME)
    : path.join(os.homedir(), ".task-orchestrator");
}

export function projectsDir(): string {
  return path.join(orchestratorHome(), "projects");
}

export function projectConfigPath(projectName: string): string {
  return path.join(projectsDir(), `${projectName}.yaml`);
}

export function stateRootDir(): string {
  return path.join(orchestratorHome(), "state");
}

export function stateBaseDir(projectName: string): string {
  return path.join(stateRootDir(), projectName);
}

export function logsBaseDir(projectName: string): string {
  return path.join(orchestratorHome(), "logs", projectName);
}

export function runStateDir(projectName: string): string {
  return stateBaseDir(projectName);
}

export function runStatePath(projectName: string, runId: string): string {
  return path.join(stateBaseDir(projectName), `run-${runId}.json`);
}

export function runStateTempPath(projectName: string, runId: string): string {
  return path.join(stateBaseDir(projectName), `run-${runId}.json.tmp`);
}

export function runLogsDir(projectName: string, runId: string): string {
  return path.join(logsBaseDir(projectName), `run-${runId}`);
}

export function orchestratorLogPath(projectName: string, runId: string): string {
  return path.join(runLogsDir(projectName, runId), "orchestrator.jsonl");
}

export function plannerLogPath(projectName: string, runId: string): string {
  return path.join(runLogsDir(projectName, runId), "planner.jsonl");
}

export function runWorkspaceDir(projectName: string, runId: string): string {
  return path.join(orchestratorHome(), "workspaces", projectName, `run-${runId}`);
}

export function taskWorkspaceDir(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  return path.join(runWorkspaceDir(projectName, runId), "tasks", `${taskId}-${taskSlug}`);
}

export function taskLogsDir(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  return path.join(runLogsDir(projectName, runId), "tasks", `${taskId}-${taskSlug}`);
}

export function taskEventsLogPath(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  return path.join(taskLogsDir(projectName, runId, taskId, taskSlug), "events.jsonl");
}

export function plannerHomeDir(projectName: string): string {
  return path.join(orchestratorHome(), "codex", projectName, "planner");
}

export function workerCodexHomeDir(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  return path.join(runWorkspaceDir(projectName, runId), "codex", `${taskId}-${taskSlug}`);
}
