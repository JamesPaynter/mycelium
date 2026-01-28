import fs from "node:fs";
import path from "node:path";

import fse from "fs-extra";

import { TaskError, UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";

export type TasksLayout = "legacy" | "kanban";
export type TaskStage = "backlog" | "active" | "legacy";
export type TaskMoveStage = "backlog" | "active" | "archive";
export type TaskMoveResult = {
  moved: boolean;
  fromPath: string;
  toPath: string;
};

// =============================================================================
// ERROR NORMALIZATION
// =============================================================================

const TASK_LAYOUT_HINT =
  "Rerun `mycelium plan` to regenerate tasks, or check `tasks_dir` in your repo config.";

function createTaskLayoutError(args: {
  title: string;
  message: string;
  detail: string;
}): UserFacingError {
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: args.title,
    message: args.message,
    hint: TASK_LAYOUT_HINT,
    cause: new TaskError(args.detail),
  });
}

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
    throw createTaskLayoutError({
      title: "Task layout error.",
      message: "Legacy tasks cannot be moved between stages.",
      detail: `Cannot move task ${args.taskDirName} from legacy layout.`,
    });
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
    throw createTaskLayoutError({
      title: "Task directory missing.",
      message: "Task directory not found.",
      detail: `Task directory missing at ${fromPath}.`,
    });
  }

  if (toExists) {
    throw createTaskLayoutError({
      title: "Task destination exists.",
      message: "Task destination already exists.",
      detail: `Task destination already exists at ${toPath}.`,
    });
  }

  await fse.ensureDir(path.dirname(toPath));
  await fse.move(fromPath, toPath, { overwrite: false });

  return { moved: true, fromPath, toPath };
}

function requireRunId(runId: string | undefined, taskDirName: string): string {
  if (!runId) {
    throw createTaskLayoutError({
      title: "Task archive failed.",
      message: "Run id is required to archive tasks.",
      detail: `runId is required to archive task ${taskDirName}.`,
    });
  }
  return runId;
}
