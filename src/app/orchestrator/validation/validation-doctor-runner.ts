import path from "node:path";

import { validatorsLogsDir } from "../../../core/paths.js";
import type { ValidatorStatus } from "../../../core/state.js";
import type { DoctorValidationReport } from "../../../validators/doctor-validator.js";
import {
  VALIDATOR_ID as DOCTOR_VALIDATOR_ID,
  VALIDATOR_NAME as DOCTOR_VALIDATOR_NAME,
} from "../../../validators/doctor-validator.js";
import { formatErrorMessage } from "../helpers/errors.js";

import { summarizeDoctorReport } from "./summaries.js";
import type { DoctorValidationOutcome, ValidationResult } from "./types.js";
import { buildBlockResult } from "./validation-blocks.js";
import {
  findLatestReport,
  listValidatorReports,
  relativeReportPath,
} from "./validation-helpers.js";
import type {
  DoctorValidationContext,
  ValidationRunnerContext,
} from "./validation-runner-types.js";

export async function runDoctorValidation(
  context: ValidationRunnerContext,
  input: DoctorValidationContext,
): Promise<DoctorValidationOutcome | null> {
  if (!context.validators.doctor.enabled || !context.validators.doctor.config) {
    return null;
  }

  const reportDir = path.join(
    validatorsLogsDir(context.projectName, context.runId, context.paths),
    DOCTOR_VALIDATOR_NAME,
  );
  const before = await listValidatorReports(reportDir);

  let doctorResult: DoctorValidationReport | null = null;
  let error: string | null = null;
  const startedAt = Date.now();
  try {
    doctorResult = await context.runner.runDoctorValidator({
      projectName: context.projectName,
      repoPath: context.repoPath,
      runId: context.runId,
      mainBranch: context.mainBranch,
      doctorCommand: input.doctorCommand,
      doctorCanary: input.doctorCanary,
      trigger: input.trigger,
      triggerNotes: input.triggerNotes,
      integrationDoctorOutput: input.integrationDoctorOutput,
      config: context.validators.doctor.config,
      orchestratorLog: context.orchestratorLog,
      logger: context.loggers.doctor,
      paths: context.paths,
    });
  } catch (err) {
    error = formatErrorMessage(err);
  } finally {
    context.onDoctorDuration?.(Date.now() - startedAt);
  }

  const reportPath = await findLatestReport(reportDir, before);
  if (doctorResult) {
    const status: ValidatorStatus =
      input.doctorCanary?.status === "unexpected_pass"
        ? "fail"
        : doctorResult.effective
          ? "pass"
          : "fail";

    const normalized = buildValidationResult({
      validator: DOCTOR_VALIDATOR_ID,
      status,
      summary: summarizeDoctorReport(doctorResult, input.doctorCanary),
      reportPath: relativeReportPath(context.projectName, context.runId, reportPath, context.paths),
      mode: context.validators.doctor.mode,
      trigger: input.trigger,
    });

    return { result: normalized, blocked: buildBlockResult(normalized) };
  }

  const normalized = buildValidationResult({
    validator: DOCTOR_VALIDATOR_ID,
    status: "error",
    summary: error ?? "Doctor validator returned no result (see validator log).",
    reportPath: relativeReportPath(context.projectName, context.runId, reportPath, context.paths),
    mode: context.validators.doctor.mode,
    trigger: input.trigger,
  });
  return { result: normalized, blocked: buildBlockResult(normalized) };
}

function buildValidationResult(input: ValidationResult): ValidationResult {
  return input;
}
