import type { DoctorValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import type { PathsContext } from "../core/paths.js";
import { validatorLogPath } from "../core/paths.js";
import { renderPromptTemplate } from "../core/prompts.js";
import type { LlmClient } from "../llm/client.js";

import {
  DoctorValidationSchema,
  DoctorValidatorJsonSchema,
  buildDoctorExpectations,
  buildValidationContext,
  computeRunStats,
  formatDoctorCanaryForPrompt,
  formatDoctorRunsForPrompt,
  persistReport,
  type DoctorCanaryResult,
  type DoctorValidationReport,
  type DoctorValidatorTrigger,
} from "./doctor-validator-helpers.js";
import { createValidatorClient } from "./lib/client.js";
import { formatError, normalizeCompletion, secondsToMs } from "./lib/normalize.js";

export type {
  DoctorCanaryResult,
  DoctorValidationReport,
  DoctorValidatorTrigger,
} from "./doctor-validator-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export type DoctorValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  mainBranch: string;
  doctorCommand: string;
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
  config?: DoctorValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
  paths?: PathsContext;
};

// =============================================================================
// CONSTANTS
// =============================================================================

export const VALIDATOR_NAME = "doctor-validator";
export const VALIDATOR_ID = "doctor";

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runDoctorValidator(
  args: DoctorValidatorArgs,
): Promise<DoctorValidationReport | null> {
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
    trigger: args.trigger,
  });
  validatorLog.log({
    type: "validation.start",
    payload: { validator: VALIDATOR_ID, trigger: args.trigger },
  });

  try {
    const context = await buildValidationContext({
      projectName: args.projectName,
      runId: args.runId,
      repoPath: args.repoPath,
      mainBranch: args.mainBranch,
      doctorCommand: args.doctorCommand,
      trigger: args.trigger,
      triggerNotes: args.triggerNotes,
      integrationDoctorOutput: args.integrationDoctorOutput,
      doctorCanary: args.doctorCanary,
      paths: args.paths,
    });

    const prompt = await renderPromptTemplate("doctor-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      doctor_command: args.doctorCommand,
      recent_doctor_runs: formatDoctorRunsForPrompt(context.doctorRuns),
      recent_changes: context.diffSummary,
      doctor_expectations: buildDoctorExpectations(context),
      doctor_canary: formatDoctorCanaryForPrompt(context.doctorCanary),
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<DoctorValidationReport>(prompt, {
      schema: DoctorValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion, DoctorValidationSchema, "Doctor");
    const stats = computeRunStats(context.doctorRuns);

    validatorLog.log({
      type: "validation.analysis",
      payload: {
        validator: VALIDATOR_ID,
        trigger: args.trigger,
        doctor_runs: context.doctorRuns.length,
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
      paths: args.paths,
      result,
      context,
      stats,
      finishReason: completion.finishReason,
    });

    logOrchestratorEvent(
      args.orchestratorLog,
      result.effective ? "validator.pass" : "validator.fail",
      {
        validator: VALIDATOR_ID,
        trigger: args.trigger,
      },
    );

    return result;
  } catch (err) {
    const message = formatError(err);
    validatorLog.log({
      type: "validation.error",
      payload: { validator: VALIDATOR_ID, trigger: args.trigger, message },
    });
    logOrchestratorEvent(args.orchestratorLog, "validator.error", {
      validator: VALIDATOR_ID,
      trigger: args.trigger,
      message,
    });
    return null;
  } finally {
    if (shouldCloseLog) {
      validatorLog.close();
    }
  }
}
