import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function orchestratorHome(): string {
  return process.env.MYCELIUM_HOME
    ? path.resolve(process.env.MYCELIUM_HOME)
    : path.join(os.homedir(), ".mycelium");
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

export function resolveRunLogsDir(
  projectName: string,
  runId?: string,
): { runId: string; dir: string } | null {
  const base = logsBaseDir(projectName);
  if (!fs.existsSync(base)) return null;

  if (runId) {
    const dir = path.join(base, `run-${runId}`);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? { runId, dir } : null;
  }

  const runDirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"));

  if (runDirs.length === 0) {
    return null;
  }

  const withMtime = runDirs
    .map((entry) => {
      const dir = path.join(base, entry.name);
      const stat = fs.statSync(dir);
      return { dir, runId: entry.name.replace(/^run-/, ""), mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latest = withMtime[0];
  return { runId: latest.runId, dir: latest.dir };
}

export function workspacesRoot(): string {
  return path.join(orchestratorHome(), "workspaces");
}

export function projectWorkspacesDir(projectName: string): string {
  return path.join(workspacesRoot(), projectName);
}

export function orchestratorLogPath(projectName: string, runId: string): string {
  return path.join(runLogsDir(projectName, runId), "orchestrator.jsonl");
}

export function plannerLogPath(projectName: string, runId: string): string {
  return path.join(runLogsDir(projectName, runId), "planner.jsonl");
}

export function validatorsLogsDir(projectName: string, runId: string): string {
  return path.join(runLogsDir(projectName, runId), "validators");
}

export function validatorLogPath(
  projectName: string,
  runId: string,
  validatorName: string,
): string {
  return path.join(validatorsLogsDir(projectName, runId), `${validatorName}.jsonl`);
}

export function validatorReportPath(
  projectName: string,
  runId: string,
  validatorName: string,
  taskId: string,
  taskSlug: string,
): string {
  const safeSlug = taskSlug.length > 0 ? taskSlug : "task";
  return path.join(validatorsLogsDir(projectName, runId), validatorName, `${taskId}-${safeSlug}.json`);
}

export function runWorkspaceDir(projectName: string, runId: string): string {
  return path.join(projectWorkspacesDir(projectName), `run-${runId}`);
}

export function taskWorkspaceDir(projectName: string, runId: string, taskId: string): string {
  return path.join(runWorkspaceDir(projectName, runId), `task-${taskId}`);
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

export function taskComplianceReportPath(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  return path.join(taskLogsDir(projectName, runId, taskId, taskSlug), "compliance.json");
}

export function taskLockDerivationReportPath(
  repoPath: string,
  runId: string,
  taskId: string,
): string {
  return path.join(
    repoPath,
    ".mycelium",
    "reports",
    "control-plane",
    "lock-derivation",
    runId,
    `${taskId}.json`,
  );
}

export function taskBlastReportPath(
  repoPath: string,
  runId: string,
  taskId: string,
): string {
  return path.join(
    repoPath,
    ".mycelium",
    "reports",
    "control-plane",
    "blast",
    runId,
    `${taskId}.json`,
  );
}

export function taskChecksetReportPath(
  repoPath: string,
  runId: string,
  taskId: string,
): string {
  return path.join(
    repoPath,
    ".mycelium",
    "reports",
    "control-plane",
    "checkset",
    runId,
    `${taskId}.json`,
  );
}

export function taskPolicyReportPath(
  repoPath: string,
  runId: string,
  taskId: string,
): string {
  return path.join(
    repoPath,
    ".mycelium",
    "reports",
    "control-plane",
    "policy",
    runId,
    `${taskId}.json`,
  );
}

export function runSummaryReportPath(repoPath: string, runId: string): string {
  return path.join(
    repoPath,
    ".mycelium",
    "reports",
    "control-plane",
    "run-summary",
    `${runId}.json`,
  );
}

export function plannerHomeDir(projectName: string): string {
  return path.join(orchestratorHome(), "codex", projectName, "planner");
}

export function workerCodexHomeDir(
  projectName: string,
  runId: string,
  taskId: string,
  _taskSlug: string,
): string {
  return path.join(
    taskWorkspaceDir(projectName, runId, taskId),
    ".mycelium",
    "codex-home",
  );
}
