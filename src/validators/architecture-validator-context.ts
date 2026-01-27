import fg from "fast-glob";
import fse from "fs-extra";

import { taskBlastReportPath } from "../core/paths.js";
import { resolveTaskSpecPath } from "../core/task-layout.js";
import type { TaskSpec } from "../core/task-manifest.js";
import { listChangedFiles } from "../git/changes.js";

import { readDiffSummary, readFileSamples, readTaskSpec } from "./lib/io.js";
import { normalizePath } from "./lib/normalize.js";
import type { FileSample } from "./lib/types.js";

// =============================================================================
// TYPES
// =============================================================================

export type ControlPlaneImpact = {
  touched_components: string[];
  impacted_components: string[];
  confidence?: string;
  widening_reasons: string[];
};

export type ValidationContext = {
  taskSpec: string;
  architectureDocs: FileSample[];
  changedFiles: FileSample[];
  diffSummary: string;
  controlPlaneImpact: ControlPlaneImpact | null;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const DOC_SNIPPET_LIMIT = 4_000;
const FILE_SNIPPET_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 4_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const MAX_DOCS = 6;
const MAX_CHANGED_FILES = 12;

// =============================================================================
// PUBLIC HELPERS
// =============================================================================

export async function buildValidationContext(params: {
  tasksRoot: string;
  task: TaskSpec;
  workspacePath: string;
  mainBranch: string;
  repoPath: string;
  runId: string;
  docsGlob: string;
}): Promise<ValidationContext> {
  const taskSpecPath = resolveTaskSpecPath({
    tasksRoot: params.tasksRoot,
    stage: params.task.stage,
    taskDirName: params.task.taskDirName,
  });

  const [taskSpec, diffSummary, changedFiles, architectureDocs, controlPlaneImpact] =
    await Promise.all([
      readTaskSpec(taskSpecPath, TASK_SPEC_LIMIT),
      readDiffSummary(params.workspacePath, params.mainBranch, DIFF_SUMMARY_LIMIT),
      readChangedFileSamples(params.workspacePath, params.mainBranch),
      readArchitectureDocs(params.repoPath, params.docsGlob),
      readControlPlaneImpact(params.repoPath, params.runId, params.task.manifest.id),
    ]);

  return {
    taskSpec,
    architectureDocs,
    changedFiles,
    diffSummary,
    controlPlaneImpact,
  };
}

export function formatControlPlaneImpactForPrompt(impact: ControlPlaneImpact | null): string {
  if (!impact) {
    return "Unavailable";
  }

  const touched =
    impact.touched_components.length > 0 ? impact.touched_components.join(", ") : "None";
  const impacted =
    impact.impacted_components.length > 0 ? impact.impacted_components.join(", ") : "None";
  const parts = [
    `Touched components (${impact.touched_components.length}): ${touched}`,
    `Impacted components (${impact.impacted_components.length}): ${impacted}`,
  ];

  if (impact.confidence) {
    parts.push(`Blast confidence: ${impact.confidence}`);
  }

  if (impact.widening_reasons.length > 0) {
    parts.push(`Widening reasons: ${impact.widening_reasons.join(", ")}`);
  }

  return parts.join("\n");
}

// =============================================================================
// INTERNALS
// =============================================================================

async function readChangedFileSamples(
  workspacePath: string,
  mainBranch: string,
): Promise<FileSample[]> {
  const changedFiles = await listChangedFiles(workspacePath, mainBranch);
  return readFileSamples(workspacePath, changedFiles, FILE_SNIPPET_LIMIT, MAX_CHANGED_FILES);
}

async function readArchitectureDocs(repoPath: string, docsGlob: string): Promise<FileSample[]> {
  const matches = await fg(docsGlob, {
    cwd: repoPath,
    dot: true,
    onlyFiles: true,
  });
  const normalized = matches.map((docPath) => normalizePath(docPath)).sort();
  return readFileSamples(repoPath, normalized, DOC_SNIPPET_LIMIT, MAX_DOCS);
}

async function readControlPlaneImpact(
  repoPath: string,
  runId: string,
  taskId: string,
): Promise<ControlPlaneImpact | null> {
  const reportPath = taskBlastReportPath(repoPath, runId, taskId);
  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const touched = Array.isArray((raw as { touched_components?: unknown }).touched_components)
    ? ((raw as { touched_components?: string[] }).touched_components ?? [])
    : [];
  const impacted = Array.isArray((raw as { impacted_components?: unknown }).impacted_components)
    ? ((raw as { impacted_components?: string[] }).impacted_components ?? [])
    : [];
  const confidence =
    typeof (raw as { confidence?: unknown }).confidence === "string"
      ? (raw as { confidence?: string }).confidence
      : undefined;
  const widening = Array.isArray((raw as { widening_reasons?: unknown }).widening_reasons)
    ? ((raw as { widening_reasons?: string[] }).widening_reasons ?? [])
    : [];

  return {
    touched_components: touched,
    impacted_components: impacted,
    confidence,
    widening_reasons: widening,
  };
}
