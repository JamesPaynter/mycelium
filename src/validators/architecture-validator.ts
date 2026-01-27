import type { ArchitectureValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import type { PathsContext } from "../core/paths.js";
import { validatorLogPath } from "../core/paths.js";
import { renderPromptTemplate } from "../core/prompts.js";
import type { TaskSpec } from "../core/task-manifest.js";
import type { LlmClient } from "../llm/client.js";

import {
  ArchitectureValidationSchema,
  ArchitectureValidatorJsonSchema,
  buildValidationContext,
  formatControlPlaneImpactForPrompt,
  maybeHandleEarlyExit,
  persistReport,
  type ArchitectureValidationReport,
} from "./architecture-validator-helpers.js";
import { createValidatorClient } from "./lib/client.js";
import {
  formatError,
  formatFilesForPrompt,
  normalizeCompletion,
  secondsToMs,
} from "./lib/normalize.js";

export type { ArchitectureValidationReport } from "./architecture-validator-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export type ArchitectureValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  task: TaskSpec;
  taskSlug: string;
  workspacePath: string;
  mainBranch: string;
  config?: ArchitectureValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
  paths?: PathsContext;
};

// =============================================================================
// CONSTANTS
// =============================================================================

export const VALIDATOR_NAME = "architecture-validator";
export const VALIDATOR_ID = "architecture";

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runArchitectureValidator(
  args: ArchitectureValidatorArgs,
): Promise<ArchitectureValidationReport | null> {
  const cfg = args.config;
  if (!cfg || cfg.enabled === false) {
    return null;
  }

  const validatorLog =
    args.logger ??
    new JsonlLogger(validatorLogPath(args.projectName, args.runId, VALIDATOR_NAME, args.paths), {
      runId: args.runId,
    });
  const shouldCloseLog = !args.logger;

  logOrchestratorEvent(args.orchestratorLog, "validator.start", {
    validator: VALIDATOR_ID,
    taskId: args.task.manifest.id,
  });
  validatorLog.log({
    type: "validation.start",
    taskId: args.task.manifest.id,
    payload: { validator: VALIDATOR_ID },
  });

  try {
    const context = await buildValidationContext({
      tasksRoot: args.tasksRoot,
      task: args.task,
      workspacePath: args.workspacePath,
      mainBranch: args.mainBranch,
      repoPath: args.repoPath,
      runId: args.runId,
      docsGlob: cfg.docs_glob,
    });

    const earlyResult = await maybeHandleEarlyExit({
      context,
      config: cfg,
      validatorLog,
      orchestratorLog: args.orchestratorLog,
      validatorName: VALIDATOR_NAME,
      validatorId: VALIDATOR_ID,
      projectName: args.projectName,
      runId: args.runId,
      task: args.task,
      taskSlug: args.taskSlug,
      paths: args.paths,
    });
    if (earlyResult) {
      return earlyResult;
    }

    const prompt = await renderPromptTemplate("architecture-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      task_id: args.task.manifest.id,
      task_name: args.task.manifest.name,
      task_spec: context.taskSpec,
      architecture_docs: formatFilesForPrompt(context.architectureDocs),
      changed_files: formatFilesForPrompt(context.changedFiles),
      diff_summary: context.diffSummary,
      control_plane_impact: formatControlPlaneImpactForPrompt(context.controlPlaneImpact),
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<ArchitectureValidationReport>(prompt, {
      schema: ArchitectureValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion, ArchitectureValidationSchema, "Architecture");

    validatorLog.log({
      type: "validation.analysis",
      taskId: args.task.manifest.id,
      payload: {
        validator: VALIDATOR_ID,
        docs_checked: context.architectureDocs.length,
        files_checked: context.changedFiles.length,
        concerns: result.concerns.length,
        recommendations: result.recommendations.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport({
      projectName: args.projectName,
      runId: args.runId,
      validatorName: VALIDATOR_NAME,
      validatorId: VALIDATOR_ID,
      task: args.task,
      taskSlug: args.taskSlug,
      paths: args.paths,
      context,
      result,
      docsGlob: cfg.docs_glob,
      failIfDocsMissing: cfg.fail_if_docs_missing ?? false,
      finishReason: completion.finishReason,
    });

    logOrchestratorEvent(args.orchestratorLog, result.pass ? "validator.pass" : "validator.fail", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
    });

    return result;
  } catch (err) {
    const message = formatError(err);
    validatorLog.log({
      type: "validation.error",
      taskId: args.task.manifest.id,
      payload: { validator: VALIDATOR_ID, message },
    });
    logOrchestratorEvent(args.orchestratorLog, "validator.error", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
      message,
    });
    return null;
  } finally {
    if (shouldCloseLog) {
      validatorLog.close();
    }
  }
}
