import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import { detectTasksLayout, resolveTaskManifestPath, resolveTaskSpecPath } from "./task-layout.js";
import type { TaskSpec } from "./task-manifest.js";

export type TaskFileLocation = {
  manifestPath: string;
  specPath: string;
};

export async function buildTaskFileIndex(args: {
  tasksRoot: string;
  tasks: TaskSpec[];
}): Promise<Map<string, TaskFileLocation>> {
  const index = new Map<string, TaskFileLocation>();

  for (const task of args.tasks) {
    const manifestPath = resolveTaskManifestPath({
      tasksRoot: args.tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    });
    const specPath = resolveTaskSpecPath({
      tasksRoot: args.tasksRoot,
      stage: task.stage,
      taskDirName: task.taskDirName,
    });

    const [manifestExists, specExists] = await Promise.all([
      fse.pathExists(manifestPath),
      fse.pathExists(specPath),
    ]);
    if (!manifestExists || !specExists) {
      continue;
    }

    index.set(task.manifest.id, { manifestPath, specPath });
  }

  if (!(await fse.pathExists(args.tasksRoot))) {
    return index;
  }

  const layout = detectTasksLayout(args.tasksRoot);
  const manifestGlobs =
    layout === "legacy"
      ? ["**/manifest.json"]
      : ["backlog/**/manifest.json", "active/**/manifest.json", "archive/**/manifest.json"];
  const manifestPaths = await fg(manifestGlobs, {
    cwd: args.tasksRoot,
    absolute: true,
    onlyFiles: true,
  });

  for (const manifestPath of manifestPaths) {
    const taskId = await readTaskIdFromManifest(manifestPath);
    if (!taskId || index.has(taskId)) {
      continue;
    }

    const specPath = path.join(path.dirname(manifestPath), "spec.md");
    if (!(await fse.pathExists(specPath))) {
      continue;
    }

    index.set(taskId, { manifestPath, specPath });
  }

  return index;
}

async function readTaskIdFromManifest(manifestPath: string): Promise<string | null> {
  try {
    const raw = await fse.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}
