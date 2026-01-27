import type { ArchitectureValidatorConfig } from "../core/config.js";
import type { JsonlLogger } from "../core/logger.js";
import { logOrchestratorEvent } from "../core/logger.js";
import type { PathsContext } from "../core/paths.js";
import type { TaskSpec } from "../core/task-manifest.js";

import type { ValidationContext } from "./architecture-validator-context.js";
import type { ArchitectureValidationReport } from "./architecture-validator-schema.js";
import { writeTaskValidatorReport } from "./lib/io.js";

// =============================================================================
// REPORTING
// =============================================================================

export async function persistReport(params: {
  projectName: string;
  runId: string;
  validatorName: string;
  validatorId: string;
  task: TaskSpec;
  taskSlug: string;
  paths?: PathsContext;
  context: ValidationContext;
  result: ArchitectureValidationReport;
  docsGlob: string;
  failIfDocsMissing: boolean;
  finishReason?: string | null;
}): Promise<void> {
  await writeTaskValidatorReport({
    projectName: params.projectName,
    runId: params.runId,
    validatorName: params.validatorName,
    validatorId: params.validatorId,
    taskId: params.task.manifest.id,
    taskName: params.task.manifest.name,
    taskSlug: params.taskSlug,
    paths: params.paths,
    result: params.result,
    meta: {
      docs_glob: params.docsGlob,
      fail_if_docs_missing: params.failIfDocsMissing,
      docs: params.context.architectureDocs.map((f) => f.path),
      changed_files: params.context.changedFiles.map((f) => f.path),
      diff_summary: params.context.diffSummary,
      control_plane: params.context.controlPlaneImpact,
      finish_reason: params.finishReason ?? null,
    },
  });
}

export async function maybeHandleEarlyExit(params: {
  context: ValidationContext;
  config: ArchitectureValidatorConfig;
  validatorLog: JsonlLogger;
  orchestratorLog: JsonlLogger;
  validatorName: string;
  validatorId: string;
  projectName: string;
  runId: string;
  task: TaskSpec;
  taskSlug: string;
  paths?: PathsContext;
}): Promise<ArchitectureValidationReport | null> {
  if (params.context.changedFiles.length === 0) {
    const result: ArchitectureValidationReport = {
      pass: true,
      summary: "No changed files detected; validation skipped.",
      concerns: [],
      recommendations: [],
      confidence: "high",
    };

    await persistReport({
      projectName: params.projectName,
      runId: params.runId,
      validatorName: params.validatorName,
      validatorId: params.validatorId,
      task: params.task,
      taskSlug: params.taskSlug,
      paths: params.paths,
      context: params.context,
      result,
      docsGlob: params.config.docs_glob,
      failIfDocsMissing: params.config.fail_if_docs_missing ?? false,
    });
    params.validatorLog.log({
      type: "validation.skip",
      taskId: params.task.manifest.id,
      payload: { validator: params.validatorId },
    });
    logOrchestratorEvent(params.orchestratorLog, "validator.skip", {
      validator: params.validatorId,
      taskId: params.task.manifest.id,
    });
    return result;
  }

  if (params.context.architectureDocs.length === 0) {
    if (!params.config.fail_if_docs_missing) {
      const result: ArchitectureValidationReport = {
        pass: true,
        summary: "No architecture docs found; validation skipped.",
        concerns: [],
        recommendations: [],
        confidence: "high",
      };

      await persistReport({
        projectName: params.projectName,
        runId: params.runId,
        validatorName: params.validatorName,
        validatorId: params.validatorId,
        task: params.task,
        taskSlug: params.taskSlug,
        paths: params.paths,
        context: params.context,
        result,
        docsGlob: params.config.docs_glob,
        failIfDocsMissing: params.config.fail_if_docs_missing ?? false,
      });
      params.validatorLog.log({
        type: "validation.skip",
        taskId: params.task.manifest.id,
        payload: { validator: params.validatorId },
      });
      logOrchestratorEvent(params.orchestratorLog, "validator.skip", {
        validator: params.validatorId,
        taskId: params.task.manifest.id,
      });
      return result;
    }

    const result: ArchitectureValidationReport = {
      pass: false,
      summary: "No architecture docs found; validation failed.",
      concerns: [
        {
          issue: "Architecture docs missing for validation.",
          severity: "high",
          evidence: `No docs matched glob: ${params.config.docs_glob}`,
          location: params.config.docs_glob,
          suggested_fix: "Add architecture docs or update docs_glob.",
        },
      ],
      recommendations: [
        {
          description: "Add architecture docs or update docs_glob to point to them.",
          impact: "high",
          action: `Provide docs matching: ${params.config.docs_glob}`,
        },
      ],
      confidence: "high",
    };

    params.validatorLog.log({
      type: "validation.analysis",
      taskId: params.task.manifest.id,
      payload: {
        validator: params.validatorId,
        docs_checked: 0,
        files_checked: params.context.changedFiles.length,
        concerns: result.concerns.length,
        recommendations: result.recommendations.length,
        confidence: result.confidence,
      },
    });

    await persistReport({
      projectName: params.projectName,
      runId: params.runId,
      validatorName: params.validatorName,
      validatorId: params.validatorId,
      task: params.task,
      taskSlug: params.taskSlug,
      paths: params.paths,
      context: params.context,
      result,
      docsGlob: params.config.docs_glob,
      failIfDocsMissing: params.config.fail_if_docs_missing ?? false,
    });
    logOrchestratorEvent(params.orchestratorLog, "validator.fail", {
      validator: params.validatorId,
      taskId: params.task.manifest.id,
    });
    return result;
  }

  return null;
}
