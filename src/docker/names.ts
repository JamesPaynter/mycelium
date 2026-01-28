/*
Purpose: centralize Docker container naming helpers shared across the app.
Assumptions: callers ensure uniqueness; names must be Docker-friendly.
Usage: buildWorkerContainerName({ projectName, runId, taskId, taskSlug }).
*/

const CONTAINER_NAME_LIMIT = 120;

export type WorkerContainerNameInput = {
  projectName: string;
  runId: string;
  taskId: string;
  taskSlug: string;
};

export function buildWorkerContainerName(values: WorkerContainerNameInput): string {
  const raw = `to-${values.projectName}-${values.runId}-${values.taskId}-${values.taskSlug}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, CONTAINER_NAME_LIMIT);
}

export function firstContainerName(names?: string[]): string | undefined {
  if (!names || names.length === 0) return undefined;
  const raw = names[0] ?? "";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}
