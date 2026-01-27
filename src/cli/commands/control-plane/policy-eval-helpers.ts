import type { ControlPlaneJsonError } from "../../../control-plane/cli/output.js";
import { CONTROL_PLANE_ERROR_CODES } from "../../../control-plane/cli/output.js";
import { listChangedPaths } from "../../../control-plane/git.js";
import {
  buildBlastRadiusReport,
  type ControlPlaneBlastRadiusReport,
} from "../../../control-plane/integration/blast-radius.js";
import type { DerivedScopeReport } from "../../../control-plane/integration/derived-scope.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
  type PolicyChecksetConfig,
} from "../../../control-plane/policy/eval.js";
import type {
  PolicyDecision,
  SurfaceChangeDetection,
  SurfacePatternSet,
} from "../../../control-plane/policy/types.js";

import {
  PolicyEvalInputError,
  computeLockDerivationReport,
  normalizeChangedList,
  normalizeOptionalString,
  resolvePolicyEvalConfig,
  resolvePolicyEvalManifest,
  type PolicyEvalConfigSource,
  type PolicyEvalManifestSource,
} from "./policy-eval-helpers-internals.js";

// =============================================================================
// TYPES
// =============================================================================

export type PolicyEvalOptions = {
  changed?: string[];
  diff?: string;
  against?: string;
  manifest?: string;
};

type PolicyEvalRequiredChecks = {
  mode: PolicyChecksetConfig["mode"];
  selected_command: string;
  rationale: string[];
  fallback_reason?: ChecksetReport["fallback_reason"];
  confidence: ChecksetReport["confidence"];
};

type PolicyEvalControlPlaneSummary = {
  enabled: boolean;
  config_source: PolicyEvalConfigSource;
  config_path: string | null;
  component_resource_prefix: string;
  fallback_resource: string;
  checks: {
    mode: PolicyChecksetConfig["mode"];
    max_components_for_scoped: number;
    fallback_command: string | null;
    commands_by_component: Record<string, string>;
  };
  surface_patterns: SurfacePatternSet;
  surface_locks_enabled: boolean;
};

type PolicyEvalOutput = {
  base_sha: string;
  diff: string | null;
  against: string | null;
  changed_files: string[];
  manifest: {
    source: PolicyEvalManifestSource;
    path: string | null;
    task_id: string;
    task_name: string;
  };
  control_plane: PolicyEvalControlPlaneSummary;
  lock_derivation: DerivedScopeReport;
  blast_radius: ControlPlaneBlastRadiusReport;
  surface_detection: SurfaceChangeDetection;
  tier: PolicyDecision["tier"];
  required_checks: PolicyEvalRequiredChecks;
  policy: PolicyDecision;
  checkset: {
    mode: PolicyChecksetConfig["mode"];
    report: ChecksetReport;
    doctor_command: string;
    default_doctor_command: string;
  };
};

// =============================================================================
// OUTPUT BUILDING
// =============================================================================

export async function buildPolicyEvalOutput(input: {
  repoPath: string;
  baseSha: string;
  model: ControlPlaneModel;
  options: PolicyEvalOptions;
  configPath: string | null;
}): Promise<PolicyEvalOutput> {
  const changedInput = normalizeChangedList(input.options.changed);
  const diff = normalizeOptionalString(input.options.diff);
  const against = normalizeOptionalString(input.options.against);

  if (changedInput.length === 0 && !diff && !against) {
    throw new PolicyEvalInputError("Provide --changed, --diff, or --against to evaluate policy.");
  }

  const changedFiles = await listChangedPaths({
    repoRoot: input.repoPath,
    changed: changedInput.length > 0 ? changedInput : null,
    diff,
    against,
  });

  if (changedFiles.length === 0) {
    throw new PolicyEvalInputError("No changed files found for policy evaluation.", {
      diff,
      against,
      changed: changedInput,
    });
  }

  const resolvedConfig = resolvePolicyEvalConfig({
    repoPath: input.repoPath,
    explicitConfigPath: input.configPath,
  });

  const manifestResult = await resolvePolicyEvalManifest({
    manifestPath: normalizeOptionalString(input.options.manifest),
    changedFiles,
    defaultDoctorCommand: resolvedConfig.defaultDoctorCommand,
  });

  const lockDerivation = await computeLockDerivationReport({
    manifest: manifestResult.manifest,
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    model: input.model,
    config: resolvedConfig,
  });

  const blastReport = buildBlastRadiusReport({
    task: manifestResult.manifest,
    baseSha: input.baseSha,
    changedFiles,
    model: input.model,
  });

  const policyEval = evaluateTaskPolicyDecision({
    task: manifestResult.manifest,
    derivedScopeReport: lockDerivation,
    componentResourcePrefix: resolvedConfig.componentResourcePrefix,
    fallbackResource: resolvedConfig.fallbackResource,
    model: input.model,
    checksConfig: resolvedConfig.checksConfig,
    defaultDoctorCommand: manifestResult.manifest.verify.doctor,
    surfacePatterns: resolvedConfig.surfacePatterns,
  });

  const requiredChecks: PolicyEvalRequiredChecks = {
    mode: policyEval.policyDecision.checks.mode,
    selected_command: policyEval.policyDecision.checks.selected_command,
    rationale: policyEval.policyDecision.checks.rationale,
    fallback_reason: policyEval.checksetReport.fallback_reason,
    confidence: policyEval.checksetReport.confidence,
  };

  return {
    base_sha: input.baseSha,
    diff,
    against,
    changed_files: changedFiles,
    manifest: {
      source: manifestResult.source,
      path: manifestResult.path,
      task_id: manifestResult.manifest.id,
      task_name: manifestResult.manifest.name,
    },
    control_plane: {
      enabled: resolvedConfig.controlPlaneEnabled,
      config_source: resolvedConfig.configSource,
      config_path: resolvedConfig.configPath,
      component_resource_prefix: resolvedConfig.componentResourcePrefix,
      fallback_resource: resolvedConfig.fallbackResource,
      checks: {
        mode: resolvedConfig.checksConfig.mode,
        max_components_for_scoped: resolvedConfig.checksConfig.maxComponentsForScoped,
        fallback_command: resolvedConfig.checksConfig.fallbackCommand ?? null,
        commands_by_component: resolvedConfig.checksConfig.commandsByComponent,
      },
      surface_patterns: resolvedConfig.surfacePatterns,
      surface_locks_enabled: resolvedConfig.surfaceLocksEnabled,
    },
    lock_derivation: lockDerivation,
    blast_radius: blastReport,
    surface_detection: policyEval.surfaceDetection,
    tier: policyEval.policyDecision.tier,
    required_checks: requiredChecks,
    policy: policyEval.policyDecision,
    checkset: {
      mode: policyEval.policyDecision.checks.mode,
      report: policyEval.checksetReport,
      doctor_command: policyEval.doctorCommand,
      default_doctor_command: manifestResult.manifest.verify.doctor,
    },
  };
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

export function resolvePolicyEvalError(error: unknown): ControlPlaneJsonError {
  if (error instanceof PolicyEvalInputError) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
      message: error.message,
      details: { name: error.name },
    };
  }

  return {
    code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
    message: "Policy evaluation failed.",
    details: null,
  };
}
