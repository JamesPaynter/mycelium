import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { ControlPlaneJsonError } from "../../../control-plane/cli/output.js";
import { CONTROL_PLANE_ERROR_CODES } from "../../../control-plane/cli/output.js";
import { listChangedPaths } from "../../../control-plane/git.js";
import {
  buildBlastRadiusReport,
  type ControlPlaneBlastRadiusReport,
} from "../../../control-plane/integration/blast-radius.js";
import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../../../control-plane/integration/derived-scope.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
  type PolicyChecksetConfig,
} from "../../../control-plane/policy/eval.js";
import { resolveSurfacePatterns } from "../../../control-plane/policy/surface-detect.js";
import type {
  PolicyDecision,
  SurfaceChangeDetection,
  SurfacePatternSet,
} from "../../../control-plane/policy/types.js";
import { loadProjectConfig } from "../../../core/config-loader.js";
import type { ProjectConfig } from "../../../core/config.js";
import {
  TaskManifestSchema,
  formatManifestIssues,
  normalizeTaskManifest,
  type TaskManifest,
} from "../../../core/task-manifest.js";

// =============================================================================
// TYPES
// =============================================================================

export type PolicyEvalOptions = {
  changed?: string[];
  diff?: string;
  against?: string;
  manifest?: string;
};

type PolicyEvalManifestSource = "file" | "synthetic";

type PolicyEvalConfigSource = "explicit" | "repo" | "defaults";

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

type PolicyEvalResolvedConfig = {
  configSource: PolicyEvalConfigSource;
  configPath: string | null;
  controlPlaneEnabled: boolean;
  componentResourcePrefix: string;
  fallbackResource: string;
  checksConfig: PolicyChecksetConfig;
  surfacePatterns: SurfacePatternSet;
  surfaceLocksEnabled: boolean;
  defaultDoctorCommand: string;
};

class PolicyEvalInputError extends Error {
  details: Record<string, unknown> | null;

  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.details = details;
  }
}

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

async function computeLockDerivationReport(input: {
  manifest: TaskManifest;
  repoPath: string;
  baseSha: string;
  model: ControlPlaneModel;
  config: PolicyEvalResolvedConfig;
}): Promise<DerivedScopeReport> {
  const snapshot = await createDerivedScopeSnapshot({
    repoPath: input.repoPath,
    baseSha: input.baseSha,
  });

  try {
    return await deriveTaskWriteScopeReport({
      manifest: input.manifest,
      model: input.model,
      snapshotPath: snapshot.snapshotPath,
      componentResourcePrefix: input.config.componentResourcePrefix,
      fallbackResource: input.config.fallbackResource,
      surfaceLocksEnabled: input.config.surfaceLocksEnabled,
      surfacePatterns: input.config.surfacePatterns,
    });
  } finally {
    await snapshot.release();
  }
}

async function resolvePolicyEvalManifest(input: {
  manifestPath: string | null;
  changedFiles: string[];
  defaultDoctorCommand: string;
}): Promise<{ manifest: TaskManifest; source: PolicyEvalManifestSource; path: string | null }> {
  if (input.manifestPath) {
    const manifest = await loadTaskManifestFromPath(input.manifestPath);
    return {
      manifest,
      source: "file",
      path: path.resolve(input.manifestPath),
    };
  }

  const manifest = buildSyntheticManifest({
    changedFiles: input.changedFiles,
    doctorCommand: input.defaultDoctorCommand,
  });

  return { manifest, source: "synthetic", path: null };
}

async function loadTaskManifestFromPath(manifestPath: string): Promise<TaskManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new PolicyEvalInputError("Failed to read manifest file.", {
      manifest_path: manifestPath,
      message: formatErrorMessage(error),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new PolicyEvalInputError("Manifest JSON is invalid.", {
      manifest_path: manifestPath,
      message: formatErrorMessage(error),
    });
  }

  const parsed = TaskManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new PolicyEvalInputError("Manifest schema validation failed.", {
      manifest_path: manifestPath,
      issues: formatManifestIssues(parsed.error.issues),
    });
  }

  return normalizeTaskManifest(parsed.data);
}

function buildSyntheticManifest(input: {
  changedFiles: string[];
  doctorCommand: string;
}): TaskManifest {
  return normalizeTaskManifest({
    id: "policy-eval",
    name: "Policy eval",
    description: "Synthetic manifest for policy evaluation.",
    estimated_minutes: 1,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: input.changedFiles },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: input.doctorCommand },
  });
}

function resolvePolicyEvalConfig(input: {
  repoPath: string;
  explicitConfigPath: string | null;
}): PolicyEvalResolvedConfig {
  const explicitPath = input.explicitConfigPath ? path.resolve(input.explicitConfigPath) : null;
  if (explicitPath) {
    if (!fsSync.existsSync(explicitPath)) {
      throw new PolicyEvalInputError("Project config not found.", {
        config_path: explicitPath,
      });
    }

    const config = loadProjectConfig(explicitPath);
    return buildPolicyEvalConfigFromProject({
      config,
      configSource: "explicit",
      configPath: explicitPath,
    });
  }

  const repoConfigPath = path.join(input.repoPath, ".mycelium", "config.yaml");
  if (fsSync.existsSync(repoConfigPath)) {
    const config = loadProjectConfig(repoConfigPath);
    return buildPolicyEvalConfigFromProject({
      config,
      configSource: "repo",
      configPath: repoConfigPath,
    });
  }

  return {
    configSource: "defaults",
    configPath: null,
    controlPlaneEnabled: false,
    componentResourcePrefix: "component:",
    fallbackResource: "repo-root",
    checksConfig: {
      mode: "off",
      commandsByComponent: {},
      maxComponentsForScoped: 3,
    },
    surfacePatterns: resolveSurfacePatterns(),
    surfaceLocksEnabled: false,
    defaultDoctorCommand: "npm test",
  };
}

function buildPolicyEvalConfigFromProject(input: {
  config: ProjectConfig;
  configSource: PolicyEvalConfigSource;
  configPath: string;
}): PolicyEvalResolvedConfig {
  const checks = input.config.control_plane.checks;
  return {
    configSource: input.configSource,
    configPath: input.configPath,
    controlPlaneEnabled: input.config.control_plane.enabled,
    componentResourcePrefix: input.config.control_plane.component_resource_prefix,
    fallbackResource: input.config.control_plane.fallback_resource,
    checksConfig: {
      mode: checks.mode,
      commandsByComponent: sortRecord(checks.commands_by_component ?? {}),
      maxComponentsForScoped: checks.max_components_for_scoped,
      fallbackCommand: checks.fallback_command,
    },
    surfacePatterns: resolveSurfacePatterns(input.config.control_plane.surface_patterns),
    surfaceLocksEnabled: input.config.control_plane.surface_locks?.enabled ?? false,
    defaultDoctorCommand: input.config.doctor,
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

// =============================================================================
// UTILITIES
// =============================================================================

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeChangedList(changed?: string[]): string[] {
  if (!changed || changed.length === 0) {
    return [];
  }

  return changed.map((value) => value.trim()).filter((value) => value.length > 0);
}

function normalizeOptionalString(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
