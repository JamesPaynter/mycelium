import fs from "node:fs";
import path from "node:path";

import fse from "fs-extra";

export type TasksLayout = "legacy" | "kanban";
export type TaskStage = "backlog" | "active" | "legacy";
export type TaskMoveStage = "backlog" | "active" | "archive";
export type TaskMoveResult = {
  moved: boolean;
  fromPath: string;
  toPath: string;
};

// =============================================================================
// LAYOUT DETECTION
// =============================================================================

export function resolveTasksBacklogDir(tasksRoot: string): string {
  return path.join(tasksRoot, "backlog");
}

export function resolveTasksActiveDir(tasksRoot: string): string {
  return path.join(tasksRoot, "active");
}

export function resolveTasksArchiveDir(tasksRoot: string): string {
  return path.join(tasksRoot, "archive");
}

export function detectTasksLayout(tasksRoot: string): TasksLayout {
  const backlogDir = resolveTasksBacklogDir(tasksRoot);

  try {
    return fs.statSync(backlogDir).isDirectory() ? "kanban" : "legacy";
  } catch {
    return "legacy";
  }
}

// =============================================================================
// TASK PATHS
// =============================================================================

export function resolveTaskStageDir(tasksRoot: string, stage: TaskStage): string {
  if (stage === "legacy") {
    return tasksRoot;
  }

  return stage === "backlog" ? resolveTasksBacklogDir(tasksRoot) : resolveTasksActiveDir(tasksRoot);
}

export function resolveTaskDir(args: {
  tasksRoot: string;
  stage: TaskStage;
  taskDirName: string;
}): string {
  return path.join(resolveTaskStageDir(args.tasksRoot, args.stage), args.taskDirName);
}

export function resolveTaskManifestPath(args: {
  tasksRoot: string;
  stage: TaskStage;
  taskDirName: string;
}): string {
  return path.join(resolveTaskDir(args), "manifest.json");
}

export function resolveTaskSpecPath(args: {
  tasksRoot: string;
  stage: TaskStage;
  taskDirName: string;
}): string {
  return path.join(resolveTaskDir(args), "spec.md");
}

export function resolveTaskArchivePath(args: {
  tasksRoot: string;
  runId: string;
  taskDirName: string;
}): string {
  return path.join(resolveTasksArchiveDir(args.tasksRoot), args.runId, args.taskDirName);
}

export function resolveTaskStageFromManifestPath(args: {
  tasksRoot: string;
  manifestPath: string;
  layout: TasksLayout;
}): TaskStage {
  if (args.layout === "legacy") {
    return "legacy";
  }

  const relative = path.relative(args.tasksRoot, args.manifestPath);
  const [stage] = relative.split(path.sep);
  if (stage === "backlog" || stage === "active") {
    return stage;
  }

  return "legacy";
}

// =============================================================================
// STAGE MOVES
// =============================================================================

export async function moveTaskDir(args: {
  tasksRoot: string;
  fromStage: TaskStage;
  toStage: TaskMoveStage;
  taskDirName: string;
  runId?: string;
}): Promise<TaskMoveResult> {
  if (args.fromStage === "legacy") {
    throw new Error(`Cannot move task ${args.taskDirName} from legacy layout.`);
  }

  const fromPath = resolveTaskDir({
    tasksRoot: args.tasksRoot,
    stage: args.fromStage,
    taskDirName: args.taskDirName,
  });
  const toPath =
    args.toStage === "archive"
      ? resolveTaskArchivePath({
          tasksRoot: args.tasksRoot,
          runId: requireRunId(args.runId, args.taskDirName),
          taskDirName: args.taskDirName,
        })
      : resolveTaskDir({
          tasksRoot: args.tasksRoot,
          stage: args.toStage,
          taskDirName: args.taskDirName,
        });

  if (fromPath === toPath) {
    return { moved: false, fromPath, toPath };
  }

  const [fromExists, toExists] = await Promise.all([
    fse.pathExists(fromPath),
    fse.pathExists(toPath),
  ]);

  if (!fromExists) {
    if (toExists) {
      return { moved: false, fromPath, toPath };
    }
    throw new Error(`Task directory missing at ${fromPath}.`);
  }

  if (toExists) {
    throw new Error(`Task destination already exists at ${toPath}.`);
  }

  await fse.ensureDir(path.dirname(toPath));
  await fse.move(fromPath, toPath, { overwrite: false });

  return { moved: true, fromPath, toPath };
}

function requireRunId(runId: string | undefined, taskDirName: string): string {
  if (!runId) {
    throw new Error(`runId is required to archive task ${taskDirName}.`);
  }
  return runId;
}
