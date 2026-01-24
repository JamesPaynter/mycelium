import fs from "node:fs";
import path from "node:path";

export type TasksLayout = "legacy" | "kanban";

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
