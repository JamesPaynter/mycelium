import type { DerivedScopeReport } from "../../../control-plane/integration/derived-scope.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import type { ChecksetDecision } from "../../../control-plane/policy/checkset.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
} from "../../../control-plane/policy/eval.js";
import type { PolicyDecision, SurfacePatternSet } from "../../../control-plane/policy/types.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { ControlPlaneRunConfig } from "../run-context.js";

// =============================================================================
// TYPES
// =============================================================================

export type BlastRadiusContext = {
  baseSha: string;
  model: ControlPlaneModel;
};

export type TaskPolicyDecisionResult = {
  policyDecision: PolicyDecision;
  checksetDecision: ChecksetDecision;
  checksetReport: ChecksetReport;
  doctorCommand: string;
};

// =============================================================================
// POLICY DECISIONS
// =============================================================================

export function computeTaskPolicyDecision(input: {
  task: TaskSpec;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  componentResourcePrefix: string;
  blastContext: BlastRadiusContext | null;
  checksConfig: ControlPlaneRunConfig["checks"];
  defaultDoctorCommand: string;
  surfacePatterns: SurfacePatternSet;
  fallbackResource: string;
}): TaskPolicyDecisionResult {
  const derivedScopeReport = input.derivedScopeReports.get(input.task.manifest.id) ?? null;
  const result = evaluateTaskPolicyDecision({
    task: input.task.manifest,
    derivedScopeReport,
    componentResourcePrefix: input.componentResourcePrefix,
    fallbackResource: input.fallbackResource,
    model: input.blastContext?.model ?? null,
    checksConfig: input.checksConfig,
    defaultDoctorCommand: input.defaultDoctorCommand,
    surfacePatterns: input.surfacePatterns,
  });

  return {
    policyDecision: result.policyDecision,
    checksetDecision: result.checksetDecision,
    checksetReport: result.checksetReport,
    doctorCommand: result.doctorCommand,
  };
}
