import type { PathsContext } from "../core/paths.js";

import type { ValidationContext } from "./doctor-validator-context.js";
import type { DoctorValidationReport } from "./doctor-validator-schema.js";
import { writeRunValidatorReport } from "./lib/io.js";

// =============================================================================
// REPORTING
// =============================================================================

export async function persistReport(params: {
  projectName: string;
  runId: string;
  validatorName: string;
  validatorId: string;
  paths?: PathsContext;
  result: DoctorValidationReport;
  context: ValidationContext;
  stats: { total: number; passes: number; failures: number };
  finishReason?: string | null;
}): Promise<void> {
  await writeRunValidatorReport({
    projectName: params.projectName,
    runId: params.runId,
    validatorName: params.validatorName,
    validatorId: params.validatorId,
    trigger: params.context.trigger,
    paths: params.paths,
    result: params.result,
    meta: {
      doctor_command: params.context.doctorCommand,
      diff_summary: params.context.diffSummary,
      doctor_runs: params.context.doctorRuns,
      stats: params.stats,
      integration_doctor_output: params.context.integrationDoctorOutput ?? null,
      trigger_notes: params.context.triggerNotes ?? null,
      finish_reason: params.finishReason ?? null,
      doctor_canary: params.context.doctorCanary ?? null,
    },
  });
}
