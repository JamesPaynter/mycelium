import fs from "node:fs/promises";

import { Command } from "commander";

import { computeBlastRadius } from "../../../control-plane/blast.js";
import { CONTROL_PLANE_ERROR_CODES } from "../../../control-plane/cli/output.js";
import { listChangedPaths } from "../../../control-plane/git.js";
import { taskBlastReportPath } from "../../../core/paths.js";

import type { ControlPlaneCommandContext } from "./index.js";



// =============================================================================
// TYPES
// =============================================================================

type BlastQueryOptions = {
  changed?: string[];
  diff?: string;
  against?: string;
  run?: string;
  task?: string;
};



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerBlastRadiusCommand(
  controlPlane: Command,
  ctx: ControlPlaneCommandContext,
): void {
  controlPlane
    .command("blast")
    .description("Estimate blast radius for a change")
    .argument("[targets...]", "Paths to treat as changed")
    .option("--changed <paths...>", "Paths to treat as changed")
    .option("--diff <range>", "Git diff rev range (e.g., HEAD~1..HEAD)")
    .option("--against <ref>", "Git ref to diff against HEAD")
    .option("--run <id>", "Run id for task blast artifact")
    .option("--task <id>", "Task id for task blast artifact")
    .action(async (targets, opts, command) => {
      await handleBlastQuery(ctx, targets as string[], opts as BlastQueryOptions, command);
    });
}



// =============================================================================
// COMMANDS
// =============================================================================

async function handleBlastQuery(
  ctx: ControlPlaneCommandContext,
  targets: string[],
  options: BlastQueryOptions,
  command: Command,
): Promise<void> {
  const { flags, output } = ctx.resolveCommandContext(command);
  const runId = options.run?.trim() ?? "";
  const taskId = options.task?.trim() ?? "";

  const inputError = buildBlastReportInputError(runId, taskId);
  if (inputError) {
    ctx.emitControlPlaneError(inputError, output);
    return;
  }

  try {
    const storedReport = await resolveStoredBlastReport(flags.repoPath, runId, taskId);
    if (storedReport) {
      ctx.emitControlPlaneResult(storedReport, output);
      return;
    }

    const modelResult = await ctx.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      ctx.emitModelNotBuiltError(ctx.modelNotBuiltMessage, output);
      return;
    }

    const changeInput = resolveBlastChangeInput(options, targets);
    const defaultAgainst = resolveBlastDefaultAgainst({
      runId,
      taskId,
      hasExplicitChangeInput: changeInput.hasExplicitChangeInput,
      baseSha: modelResult.baseSha,
    });
    const changedPaths = await listChangedPaths({
      repoRoot: flags.repoPath,
      changed: changeInput.changedInput,
      diff: options.diff ?? null,
      against: options.against ?? defaultAgainst,
    });

    const result = computeBlastRadius({
      changedPaths,
      model: modelResult.model,
    });

    ctx.emitControlPlaneResult(result, output);
  } catch (error) {
    ctx.emitControlPlaneError(ctx.resolveModelStoreError(error), output);
  }
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function buildBlastReportInputError(runId: string, taskId: string) {
  if ((runId && !taskId) || (!runId && taskId)) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.modelStoreError,
      message: "Provide both --run and --task to load a blast report.",
      details: null,
    };
  }

  return null;
}

async function resolveStoredBlastReport(
  repoPath: string,
  runId: string,
  taskId: string,
): Promise<unknown | null> {
  if (!runId || !taskId) {
    return null;
  }

  const reportPath = taskBlastReportPath(repoPath, runId, taskId);
  return readBlastReport(reportPath);
}

function resolveBlastChangeInput(
  options: BlastQueryOptions,
  targets: string[],
): { changedInput: string[]; hasExplicitChangeInput: boolean } {
  const changedInput =
    options.changed && options.changed.length > 0 ? options.changed : targets;
  const hasExplicitChangeInput =
    changedInput.length > 0 || Boolean(options.diff) || Boolean(options.against);

  return { changedInput, hasExplicitChangeInput };
}

function resolveBlastDefaultAgainst(input: {
  runId: string;
  taskId: string;
  hasExplicitChangeInput: boolean;
  baseSha: string;
}): string | null {
  if (!input.runId || !input.taskId || input.hasExplicitChangeInput) {
    return null;
  }

  return input.baseSha;
}

async function readBlastReport(reportPath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
