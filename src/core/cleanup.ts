import path from "node:path";

import fse from "fs-extra";

import { DockerManager, type RunContainerSummary } from "../docker/manager.js";

import type { PathsContext } from "./paths.js";
import {
  logsBaseDir,
  projectWorkspacesDir,
  runLogsDir,
  runStatePath,
  runWorkspaceDir,
  stateBaseDir,
} from "./paths.js";
import { findLatestRunId } from "./state-store.js";

type DockerManagerLike = Pick<DockerManager, "listRunContainers" | "removeContainers">;

export type CleanupTarget = { kind: "workspace" | "logs" | "state"; path: string };

export type CleanupPlan = {
  projectName: string;
  runId: string;
  targets: CleanupTarget[];
  containers: RunContainerSummary[];
  paths?: PathsContext;
};

export type BuildCleanupPlanOptions = {
  runId?: string;
  keepLogs?: boolean;
  removeContainers?: boolean;
  dockerManager?: DockerManagerLike;
  paths?: PathsContext;
};

export type ExecuteCleanupOptions = {
  dryRun?: boolean;
  log?: (message: string) => void;
  dockerManager?: DockerManagerLike;
};

export async function buildCleanupPlan(
  projectName: string,
  opts: BuildCleanupPlanOptions = {},
): Promise<CleanupPlan | null> {
  const runId = opts.runId ?? (await findLatestRunId(projectName, opts.paths));
  if (!runId) return null;

  const targets: CleanupTarget[] = [];

  const workspace = runWorkspaceDir(projectName, runId, opts.paths);
  if (await fse.pathExists(workspace)) {
    assertInsideBase(workspace, projectWorkspacesDir(projectName, opts.paths), "workspace");
    targets.push({ kind: "workspace", path: workspace });
  }

  if (!opts.keepLogs) {
    const logs = runLogsDir(projectName, runId, opts.paths);
    if (await fse.pathExists(logs)) {
      assertInsideBase(logs, logsBaseDir(projectName, opts.paths), "logs");
      targets.push({ kind: "logs", path: logs });
    }
  }

  const stateFile = runStatePath(projectName, runId, opts.paths);
  if (await fse.pathExists(stateFile)) {
    assertInsideBase(stateFile, stateBaseDir(projectName, opts.paths), "state");
    targets.push({ kind: "state", path: stateFile });
  }

  const containers =
    opts.removeContainers === true
      ? await (opts.dockerManager ?? new DockerManager()).listRunContainers(projectName, runId)
      : [];

  return { projectName, runId, targets, containers, paths: opts.paths };
}

export async function executeCleanupPlan(
  plan: CleanupPlan,
  opts: ExecuteCleanupOptions = {},
): Promise<void> {
  const log = opts.log ?? (() => undefined);

  await removeContainers(plan, opts, log);
  await removeTargets(plan, opts, log);
}

function baseDirForTarget(
  projectName: string,
  kind: CleanupTarget["kind"],
  paths?: PathsContext,
): string {
  if (kind === "workspace") return projectWorkspacesDir(projectName, paths);
  if (kind === "logs") return logsBaseDir(projectName, paths);
  return stateBaseDir(projectName, paths);
}

function assertInsideBase(targetPath: string, baseDir: string, label: string): void {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedBase, normalizedTarget);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove ${label} outside ${normalizedBase}: ${normalizedTarget}`);
  }
}

async function removeTargets(
  plan: CleanupPlan,
  opts: ExecuteCleanupOptions,
  log: (message: string) => void,
): Promise<void> {
  for (const target of plan.targets) {
    const baseDir = baseDirForTarget(plan.projectName, target.kind, plan.paths);
    assertInsideBase(target.path, baseDir, target.kind);

    if (opts.dryRun) {
      log(`[dry-run] Would remove ${target.kind}: ${target.path}`);
      continue;
    }

    await fse.remove(target.path);
    log(`Removed ${target.kind}: ${target.path}`);
  }
}

async function removeContainers(
  plan: CleanupPlan,
  opts: ExecuteCleanupOptions,
  log: (message: string) => void,
): Promise<void> {
  if (plan.containers.length === 0) return;

  if (opts.dryRun) {
    for (const container of plan.containers) {
      const label = container.name ?? container.id;
      log(`[dry-run] Would remove container: ${label}`);
    }
    return;
  }

  const manager = opts.dockerManager ?? new DockerManager();
  await manager.removeContainers(plan.containers);

  for (const container of plan.containers) {
    const label = container.name ?? container.id;
    log(`Removed container: ${label}`);
  }
}
