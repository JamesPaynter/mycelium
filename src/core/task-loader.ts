import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import { TaskError, UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import { detectTasksLayout, resolveTaskStageFromManifestPath } from "./task-layout.js";
import {
  TaskManifestSchema,
  formatManifestIssues,
  validateResourceLocks,
  type TaskSpec,
} from "./task-manifest.js";
import { slugify } from "./utils.js";

export type TaskValidationError = {
  manifestPath: string;
  taskId?: string;
  issues: string[];
};

export type TaskLoaderOptions = {
  knownResources?: string[];
  strict?: boolean; // throw when errors are present
};

export type TaskLoaderResult = {
  tasks: TaskSpec[];
  errors: TaskValidationError[];
};

export async function loadTaskSpecs(
  repoPath: string,
  tasksDirRelative: string,
  opts: TaskLoaderOptions = {},
): Promise<TaskLoaderResult> {
  const tasksDirAbs = path.resolve(repoPath, tasksDirRelative);
  const strict = opts.strict ?? true;
  const resources = opts.knownResources ?? [];

  const exists = await fse.pathExists(tasksDirAbs);
  if (!exists) {
    throw createMissingTasksDirError(tasksDirAbs);
  }

  const layout = detectTasksLayout(tasksDirAbs);
  const manifestGlobs =
    layout === "legacy"
      ? ["*/manifest.json"]
      : ["backlog/*/manifest.json", "active/*/manifest.json"];
  const manifestPaths = await fg(manifestGlobs, { cwd: tasksDirAbs, absolute: true });
  const tasks: TaskSpec[] = [];
  const errors: TaskValidationError[] = [];

  for (const manifestPath of manifestPaths) {
    const taskDir = path.dirname(manifestPath);
    const taskDirName = path.basename(taskDir);
    const stage = resolveTaskStageFromManifestPath({
      tasksRoot: tasksDirAbs,
      manifestPath,
      layout,
    });

    const parsedManifest = await parseManifest(manifestPath);
    if (!parsedManifest.success) {
      errors.push({
        manifestPath,
        taskId: parsedManifest.taskId,
        issues: parsedManifest.issues,
      });
      continue;
    }

    const manifest = parsedManifest.manifest;
    const lockIssues = validateResourceLocks(manifest, resources);
    if (lockIssues.length > 0) {
      errors.push({ manifestPath, taskId: manifest.id, issues: lockIssues });
      continue;
    }

    const slug = slugify(manifest.name);
    tasks.push({
      manifest,
      taskDirName,
      stage,
      slug,
    });
  }

  tasks.sort(compareTasksById);

  if (errors.length > 0 && strict) {
    const cause = new TaskError(buildErrorMessage(errors));
    throw createInvalidTaskManifestError(cause);
  }

  return { tasks, errors };
}

function compareTasksById(a: TaskSpec, b: TaskSpec): number {
  const ai = Number(a.manifest.id);
  const bi = Number(b.manifest.id);
  if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
  return a.manifest.id.localeCompare(b.manifest.id);
}

type ParsedManifestResult =
  | { success: true; manifest: TaskSpec["manifest"] }
  | { success: false; issues: string[]; taskId?: string };

async function parseManifest(manifestPath: string): Promise<ParsedManifestResult> {
  let manifestRaw: string;
  try {
    manifestRaw = await fse.readFile(manifestPath, "utf8");
  } catch (err) {
    return {
      success: false,
      issues: [`Failed to read manifest: ${formatError(err)}`],
    };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err) {
    return {
      success: false,
      issues: [`Invalid JSON: ${formatError(err)}`],
    };
  }

  const parsed = TaskManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    return {
      success: false,
      taskId: extractTaskId(manifestJson),
      issues: formatManifestIssues(parsed.error.issues),
    };
  }

  return { success: true, manifest: parsed.data };
}

function extractTaskId(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") {
    return raw.id;
  }
  return undefined;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function buildErrorMessage(errors: TaskValidationError[]): string {
  const details = errors
    .map((err) => {
      const idPart = err.taskId ? ` (task ${err.taskId})` : "";
      const issues = err.issues.map((i) => `  - ${i}`).join("\n");
      return `${err.manifestPath}${idPart}:\n${issues}`;
    })
    .join("\n");

  return `Invalid task manifest(s):\n${details}`;
}

const TASK_LOAD_HINT =
  "Rerun `mycelium plan` to regenerate tasks, or check `tasks_dir` in your repo config.";

function createMissingTasksDirError(tasksDirAbs: string): UserFacingError {
  const cause = new TaskError(`Tasks directory not found at ${tasksDirAbs}.`);
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: "Tasks directory missing.",
    message: "Tasks directory not found.",
    hint: TASK_LOAD_HINT,
    cause,
  });
}

function createInvalidTaskManifestError(cause: TaskError): UserFacingError {
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.task,
    title: "Task manifests invalid.",
    message: "One or more task manifests are invalid.",
    hint: TASK_LOAD_HINT,
    cause,
  });
}
