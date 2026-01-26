// Control plane policy evaluation.
// Purpose: derive policy decisions and checkset reports from task intent and graph data.

import type { TaskManifest } from "../../core/task-manifest.js";
import { normalizeFiles, normalizeLocks } from "../../core/task-manifest.js";
import type { DerivedScopeReport } from "../integration/derived-scope.js";
import type { ControlPlaneModel } from "../model/schema.js";
import { detectSurfaceChanges } from "./surface-detect.js";
import type { PolicyDecision, SurfaceChangeDetection, SurfacePatternSet } from "./types.js";
import {
  computeChecksetDecision,
  computeChecksetImpactFromGraph,
  resolveDoctorCommandForChecksetMode,
  type ChecksetConfidence,
  type ChecksetDecision,
  type ChecksetMode,
  type ChecksetWideningReason,
} from "./checkset.js";
import { classifyAutonomyTier, shouldForceGlobalChecksForTier } from "./tier.js";

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export type PolicyChecksetConfig = {
  mode: ChecksetMode;
  commandsByComponent: Record<string, string>;
  maxComponentsForScoped: number;
  fallbackCommand?: string;
};

export type ChecksetReport = {
  task_id: string;
  task_name: string;
  required_components: ChecksetDecision["required_components"];
  selected_command: ChecksetDecision["selected_command"];
  fallback_reason?: ChecksetDecision["fallback_reason"];
  confidence: ChecksetDecision["confidence"];
  rationale: ChecksetDecision["rationale"];
  surface_change: SurfaceChangeDetection;
};

export type PolicyEvaluationResult = {
  policyDecision: PolicyDecision;
  checksetDecision: ChecksetDecision;
  checksetReport: ChecksetReport;
  doctorCommand: string;
  surfaceDetection: SurfaceChangeDetection;
  touchedComponents: string[];
  impactedComponents: string[];
  impactConfidence: ChecksetConfidence;
  impactWideningReasons: ChecksetWideningReason[];
  hasRepoRootFallback: boolean;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function evaluateTaskPolicyDecision(input: {
  task: TaskManifest;
  derivedScopeReport?: DerivedScopeReport | null;
  componentResourcePrefix: string;
  fallbackResource: string;
  model: ControlPlaneModel | null;
  checksConfig: PolicyChecksetConfig;
  defaultDoctorCommand: string;
  surfacePatterns: SurfacePatternSet;
}): PolicyEvaluationResult {
  const derivedScopeReport = input.derivedScopeReport ?? null;
  const touchedComponents = resolveTaskTouchedComponents({
    task: input.task,
    derivedScopeReport,
    componentResourcePrefix: input.componentResourcePrefix,
  });
  const detectedSurface = detectSurfaceChangesForManifest({
    manifest: input.task,
    surfacePatterns: input.surfacePatterns,
  });
  const surfaceDetection = filterSurfaceDetectionForTask({
    detection: detectedSurface,
    touchedComponents,
  });
  const impact =
    input.model && touchedComponents.length > 0
      ? computeChecksetImpactFromGraph({
          touchedComponents,
          model: input.model,
        })
      : null;
  const impactedComponents = impact?.impactedComponents ?? touchedComponents;
  const impactConfidence = impact?.confidence ?? "low";
  const impactWideningReasons = impact?.wideningReasons ?? [];
  const fallbackCommand = input.checksConfig.fallbackCommand?.trim() || input.defaultDoctorCommand;
  const hasRepoRootFallback = resolveRepoRootFallback({
    derivedScopeReport,
    fallbackResource: input.fallbackResource,
  });
  const tier = classifyAutonomyTier({
    surfaceCategories: surfaceDetection.categories,
    impactedComponentCount: impactedComponents.length,
    touchedComponentCount: touchedComponents.length,
    hasRepoRootFallback,
  });

  const checksetDecision = computeChecksetDecision({
    touchedComponents,
    impactedComponents: impact?.impactedComponents,
    impactConfidence,
    impactWideningReasons,
    commandsByComponent: input.checksConfig.commandsByComponent,
    maxComponentsForScoped: input.checksConfig.maxComponentsForScoped,
    fallbackCommand,
    surfaceChange: surfaceDetection.is_surface_change,
    surfaceChangeCategories: surfaceDetection.categories,
    forceFallback: shouldForceGlobalChecksForTier(tier)
      ? { reason: "tier_high_risk", rationale: [`tier:${tier}`] }
      : undefined,
  });

  const checksetReport = buildChecksetReport({
    task: input.task,
    decision: checksetDecision,
    surfaceDetection,
  });
  const doctorCommand = resolveDoctorCommandForChecksetMode({
    mode: input.checksConfig.mode,
    decision: checksetDecision,
    defaultDoctorCommand: input.defaultDoctorCommand,
  });
  const policyDecision: PolicyDecision = {
    tier,
    surface_change: surfaceDetection.is_surface_change,
    blast_radius: {
      touched: touchedComponents.length,
      impacted: impactedComponents.length,
      confidence: impactConfidence,
    },
    checks: {
      mode: input.checksConfig.mode,
      selected_command: doctorCommand,
      rationale: checksetDecision.rationale,
    },
    locks: resolvePolicyLocks({
      task: input.task,
      derivedScopeReport,
    }),
  };

  return {
    policyDecision,
    checksetDecision,
    checksetReport,
    doctorCommand,
    surfaceDetection,
    touchedComponents,
    impactedComponents,
    impactConfidence,
    impactWideningReasons,
    hasRepoRootFallback,
  };
}

// =============================================================================
// INPUT NORMALIZATION
// =============================================================================

function detectSurfaceChangesForManifest(input: {
  manifest: TaskManifest;
  surfacePatterns: SurfacePatternSet;
}): SurfaceChangeDetection {
  const writeGlobs = normalizeFiles(input.manifest.files).writes;
  return detectSurfaceChanges(writeGlobs, input.surfacePatterns);
}

function resolveTaskTouchedComponents(input: {
  task: TaskManifest;
  derivedScopeReport: DerivedScopeReport | null;
  componentResourcePrefix: string;
}): string[] {
  const declaredLocks = normalizeLocks(input.task.locks);
  const derivedResources = input.derivedScopeReport?.derived_write_resources ?? [];

  const derivedComponents = extractComponentIdsFromResources(
    derivedResources,
    input.componentResourcePrefix,
  );
  const declaredComponents = extractComponentIdsFromResources(
    declaredLocks.writes,
    input.componentResourcePrefix,
  );

  return Array.from(new Set([...derivedComponents, ...declaredComponents])).sort();
}

function extractComponentIdsFromResources(resources: string[], prefix: string): string[] {
  const components = new Set<string>();

  for (const resource of resources) {
    if (!resource.startsWith(prefix)) {
      continue;
    }

    const componentId = resource.slice(prefix.length).trim();
    if (componentId.length > 0) {
      components.add(componentId);
    }
  }

  return Array.from(components).sort();
}

// =============================================================================
// POLICY LOCKS
// =============================================================================

function resolvePolicyLocks(input: {
  task: TaskManifest;
  derivedScopeReport: DerivedScopeReport | null;
}): PolicyDecision["locks"] {
  const declared = normalizeLocks(input.task.locks);
  const report = input.derivedScopeReport;

  if (!report) {
    return { declared };
  }

  const derivedLocks = report.derived_locks ?? {
    reads: [],
    writes: report.derived_write_resources,
  };

  return { declared, derived: normalizeLocks(derivedLocks) };
}

function resolveRepoRootFallback(input: {
  derivedScopeReport: DerivedScopeReport | null;
  fallbackResource: string;
}): boolean {
  const report = input.derivedScopeReport;
  if (!report) {
    return false;
  }

  const fallbackResource = input.fallbackResource.trim();
  const derivedWrites = report.derived_locks?.writes ?? report.derived_write_resources;

  if (fallbackResource.length > 0 && derivedWrites.includes(fallbackResource)) {
    return true;
  }

  return report.confidence === "low";
}

// =============================================================================
// SURFACE FILTERING
// =============================================================================

function buildChecksetReport(input: {
  task: TaskManifest;
  decision: ChecksetDecision;
  surfaceDetection: SurfaceChangeDetection;
}): ChecksetReport {
  return {
    task_id: input.task.id,
    task_name: input.task.name,
    required_components: input.decision.required_components,
    selected_command: input.decision.selected_command,
    fallback_reason: input.decision.fallback_reason,
    confidence: input.decision.confidence,
    rationale: input.decision.rationale,
    surface_change: input.surfaceDetection,
  };
}

function buildEmptySurfaceDetection(): SurfaceChangeDetection {
  return {
    is_surface_change: false,
    categories: [],
    matched_files: {},
  };
}

function filterSurfaceDetectionForTask(input: {
  detection: SurfaceChangeDetection;
  touchedComponents: string[];
}): SurfaceChangeDetection {
  if (!input.detection.is_surface_change) {
    return input.detection;
  }

  if (input.touchedComponents.length === 0) {
    return input.detection;
  }

  const matchedComponents = input.detection.matched_components;
  if (!matchedComponents || matchedComponents.length === 0) {
    return input.detection;
  }

  const touchedSet = new Set(input.touchedComponents);
  const filteredComponents = matchedComponents.filter((component) => touchedSet.has(component));
  if (filteredComponents.length === 0) {
    return buildEmptySurfaceDetection();
  }

  const matchedByCategory = input.detection.matched_components_by_category;
  if (!matchedByCategory) {
    return {
      ...input.detection,
      matched_components: filteredComponents,
    };
  }

  const filteredCategories: SurfaceChangeDetection["categories"] = [];
  const filteredFiles: SurfaceChangeDetection["matched_files"] = {};
  const filteredComponentsByCategory: SurfaceChangeDetection["matched_components_by_category"] = {};

  for (const category of input.detection.categories) {
    const categoryComponents = matchedByCategory[category];
    if (!categoryComponents || categoryComponents.length === 0) {
      continue;
    }

    const relevantComponents = categoryComponents.filter((component) => touchedSet.has(component));
    if (relevantComponents.length === 0) {
      continue;
    }

    filteredCategories.push(category);
    if (input.detection.matched_files[category]) {
      filteredFiles[category] = input.detection.matched_files[category];
    }
    filteredComponentsByCategory[category] = relevantComponents;
  }

  if (filteredCategories.length === 0) {
    return buildEmptySurfaceDetection();
  }

  return {
    is_surface_change: true,
    categories: filteredCategories,
    matched_files: filteredFiles,
    matched_components: filteredComponents,
    matched_components_by_category: filteredComponentsByCategory,
  };
}
