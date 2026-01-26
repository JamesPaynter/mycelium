// Validators shared IO helpers.
// Purpose: centralize validator report persistence and common file reads.
// Assumes report paths are derived from core/paths helpers.

import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";

import { validatorReportPath, validatorsLogsDir, type PathsContext } from "../../core/paths.js";
import { readJsonFile, writeJsonFile } from "../../core/utils.js";

import { truncate, uniq } from "./normalize.js";
import type { FileSample, RunValidatorReport, TaskValidatorReport } from "./types.js";


// =============================================================================
// TYPES
// =============================================================================

export type TaskValidatorReportInput<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = {
  projectName: string;
  runId: string;
  validatorName: string;
  validatorId: string;
  taskId: string;
  taskName: string;
  taskSlug: string;
  paths?: PathsContext;
  result: TResult;
  meta: TMeta;
};

export type RunValidatorReportInput<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = {
  projectName: string;
  runId: string;
  validatorName: string;
  validatorId: string;
  trigger: string;
  paths?: PathsContext;
  result: TResult;
  meta: TMeta;
  label?: string;
};


// =============================================================================
// READ HELPERS
// =============================================================================

export async function readTaskSpec(specPath: string, limit: number): Promise<string> {
  try {
    const raw = await fse.readFile(specPath, "utf8");
    return truncate(raw, limit).text;
  } catch {
    return "<task spec unavailable>";
  }
}

export async function readDiffSummary(
  workspacePath: string,
  mainBranch: string,
  limit: number,
): Promise<string> {
  const res = await execa("git", ["diff", "--stat", `${mainBranch}...HEAD`], {
    cwd: workspacePath,
    reject: false,
    stdio: "pipe",
  });

  if (res.exitCode !== 0) {
    return "<diff summary unavailable>";
  }

  const summary = res.stdout.trim();
  if (!summary) return "<no diff summary>";

  return truncate(summary, limit).text;
}

export async function readFileSamples(
  baseDir: string,
  relativePaths: string[],
  limit: number,
  maxFiles?: number,
): Promise<FileSample[]> {
  const unique = uniq(relativePaths);
  const capped = maxFiles === undefined ? unique : unique.slice(0, maxFiles);
  const samples: FileSample[] = [];

  for (const rel of capped) {
    const abs = path.join(baseDir, rel);
    const stat = await fse.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;

    const raw = await fse.readFile(abs, "utf8");
    const { text, truncated } = truncate(raw, limit);
    samples.push({ path: rel, content: text, truncated });
  }

  return samples;
}

export async function readValidatorReport<TReport = unknown>(reportPath: string): Promise<TReport> {
  return readJsonFile<TReport>(reportPath);
}


// =============================================================================
// WRITE HELPERS
// =============================================================================

export async function writeTaskValidatorReport<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(input: TaskValidatorReportInput<TResult, TMeta>): Promise<string> {
  const reportPath = validatorReportPath(
    input.projectName,
    input.runId,
    input.validatorName,
    input.taskId,
    input.taskSlug,
    input.paths,
  );

  const report: TaskValidatorReport<TResult, TMeta> = {
    task_id: input.taskId,
    task_name: input.taskName,
    task_slug: input.taskSlug,
    validator: input.validatorId,
    run_id: input.runId,
    result: input.result,
    meta: input.meta,
  };

  await writeJsonFile(reportPath, report);
  return reportPath;
}

export async function writeRunValidatorReport<
  TResult,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(input: RunValidatorReportInput<TResult, TMeta>): Promise<string> {
  const label = input.label ?? `${input.trigger}-${Date.now()}`;
  const reportPath = path.join(
    validatorsLogsDir(input.projectName, input.runId, input.paths),
    input.validatorName,
    `${label}.json`,
  );

  const report: RunValidatorReport<TResult, TMeta> = {
    project: input.projectName,
    run_id: input.runId,
    validator: input.validatorId,
    trigger: input.trigger,
    result: input.result,
    meta: input.meta,
  };

  await writeJsonFile(reportPath, report);
  return reportPath;
}
