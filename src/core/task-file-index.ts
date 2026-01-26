import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import type { TaskSpec } from "./task-manifest.js";
import {
  resolveTaskManifestPath,
  resolveTaskSpecPath,
  resolveTasksArchiveDir,
} from "./task-layout.js";

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

  const archiveDir = resolveTasksArchiveDir(args.tasksRoot);
  if (!(await fse.pathExists(archiveDir))) {
    return index;
  }

  const archiveManifestPaths = await fg("archive/*/*/manifest.json", {
    cwd: args.tasksRoot,
    absolute: true,
  });

  for (const manifestPath of archiveManifestPaths) {
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
