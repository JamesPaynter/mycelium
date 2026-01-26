import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// =============================================================================
// TYPES
// =============================================================================

export type PathsContext = {
  myceliumHome: string;
};

export type ResolveMyceliumHomeOptions = {
  myceliumHome?: string;
  repoPath?: string;
};


// =============================================================================
// CONTEXT
// =============================================================================

export function resolveMyceliumHome(opts: ResolveMyceliumHomeOptions = {}): string {
  if (opts.myceliumHome) {
    return path.resolve(opts.myceliumHome);
  }

  if (process.env.MYCELIUM_HOME) {
    return path.resolve(process.env.MYCELIUM_HOME);
  }

  if (opts.repoPath) {
    return path.join(path.resolve(opts.repoPath), ".mycelium");
  }

  return path.join(os.homedir(), ".mycelium");
}

export function createPathsContext(opts: ResolveMyceliumHomeOptions): PathsContext {
  return { myceliumHome: resolveMyceliumHome(opts) };
}

function normalizeMyceliumHome(paths?: PathsContext): string {
  return resolveMyceliumHome({ myceliumHome: paths?.myceliumHome });
}


// =============================================================================
// PATH HELPERS
// =============================================================================

export function orchestratorHome(paths?: PathsContext): string {
  return normalizeMyceliumHome(paths);
}

export function projectsDir(paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "projects");
}

export function projectConfigPath(projectName: string, paths?: PathsContext): string {
  return path.join(projectsDir(paths), `${projectName}.yaml`);
}

export function stateRootDir(paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "state");
}

export function stateBaseDir(projectName: string, paths?: PathsContext): string {
  return path.join(stateRootDir(paths), projectName);
}

export function logsBaseDir(projectName: string, paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "logs", projectName);
}

export function historyBaseDir(paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "history");
}

export function runHistoryDir(projectName: string, paths?: PathsContext): string {
  return path.join(historyBaseDir(paths), projectName);
}

export function runHistoryIndexPath(projectName: string, paths?: PathsContext): string {
  return path.join(runHistoryDir(projectName, paths), "runs.json");
}

export function taskLedgerPath(projectName: string, paths?: PathsContext): string {
  return path.join(runHistoryDir(projectName, paths), "tasks.json");
}

export function runStateDir(projectName: string, paths?: PathsContext): string {
  return stateBaseDir(projectName, paths);
}

export function runStatePath(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(stateBaseDir(projectName, paths), `run-${runId}.json`);
}

export function runStateTempPath(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(stateBaseDir(projectName, paths), `run-${runId}.json.tmp`);
}

export function runLogsDir(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(logsBaseDir(projectName, paths), `run-${runId}`);
}

export function resolveRunLogsDir(
  projectName: string,
  runId?: string,
  paths?: PathsContext,
): { runId: string; dir: string } | null {
  const base = logsBaseDir(projectName, paths);
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

export function workspacesRoot(paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "workspaces");
}

export function projectWorkspacesDir(projectName: string, paths?: PathsContext): string {
  return path.join(workspacesRoot(paths), projectName);
}

export function orchestratorLogPath(
  projectName: string,
  runId: string,
  paths?: PathsContext,
): string {
  return path.join(runLogsDir(projectName, runId, paths), "orchestrator.jsonl");
}

export function plannerLogPath(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(runLogsDir(projectName, runId, paths), "planner.jsonl");
}

export function validatorsLogsDir(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(runLogsDir(projectName, runId, paths), "validators");
}

export function validatorLogPath(
  projectName: string,
  runId: string,
  validatorName: string,
  paths?: PathsContext,
): string {
  return path.join(validatorsLogsDir(projectName, runId, paths), `${validatorName}.jsonl`);
}

export function validatorReportPath(
  projectName: string,
  runId: string,
  validatorName: string,
  taskId: string,
  taskSlug: string,
  paths?: PathsContext,
): string {
  const safeSlug = taskSlug.length > 0 ? taskSlug : "task";
  return path.join(
    validatorsLogsDir(projectName, runId, paths),
    validatorName,
    `${taskId}-${safeSlug}.json`,
  );
}

export function runWorkspaceDir(projectName: string, runId: string, paths?: PathsContext): string {
  return path.join(projectWorkspacesDir(projectName, paths), `run-${runId}`);
}

export function taskWorkspaceDir(
  projectName: string,
  runId: string,
  taskId: string,
  paths?: PathsContext,
): string {
  return path.join(runWorkspaceDir(projectName, runId, paths), `task-${taskId}`);
}

export function taskLogsDir(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
  paths?: PathsContext,
): string {
  return path.join(
    runLogsDir(projectName, runId, paths),
    "tasks",
    `${taskId}-${taskSlug}`,
  );
}

export function taskEventsLogPath(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
  paths?: PathsContext,
): string {
  return path.join(taskLogsDir(projectName, runId, taskId, taskSlug, paths), "events.jsonl");
}

export function taskComplianceReportPath(
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
  paths?: PathsContext,
): string {
  return path.join(taskLogsDir(projectName, runId, taskId, taskSlug, paths), "compliance.json");
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

export function plannerHomeDir(projectName: string, paths?: PathsContext): string {
  return path.join(orchestratorHome(paths), "codex", projectName, "planner");
}

export function workerCodexHomeDir(
  projectName: string,
  runId: string,
  taskId: string,
  _taskSlug: string,
  paths?: PathsContext,
): string {
  return path.join(
    taskWorkspaceDir(projectName, runId, taskId, paths),
    ".mycelium",
    "codex-home",
  );
}
