// Control graph scope enforcement helpers.
// Purpose: compare real changed files to declared/derived component scope.
// Assumes change manifest changed_files are repo-relative paths.

import { normalizeLocks, type TaskManifest } from "../../core/task-manifest.js";
import { resolveOwnershipForPath } from "../extract/ownership.js";
import type { ControlPlaneModel } from "../model/schema.js";

import type { TaskChangeManifest } from "./change-manifest.js";
import type { DerivedScopeReport } from "./derived-scope.js";

// =============================================================================
// TYPES
// =============================================================================

export type ControlGraphScopeEvaluation = {
  status: "pass" | "out_of_scope" | "unmapped";
  changedFiles: string[];
  touchedComponents: string[];
  allowedComponents: string[];
  missingComponents: string[];
  unmappedFiles: string[];
  reason: string;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function evaluateControlGraphScope(input: {
  manifest: TaskManifest;
  derivedScopeReport: DerivedScopeReport | null;
  changeManifest: TaskChangeManifest;
  componentResourcePrefix: string;
  model: ControlPlaneModel | null;
}): ControlGraphScopeEvaluation {
  const changedFiles = normalizeChangedFiles(input.changeManifest.changed_files);
  if (changedFiles.length === 0) {
    return {
      status: "pass",
      changedFiles,
      touchedComponents: [],
      allowedComponents: resolveAllowedComponents(input),
      missingComponents: [],
      unmappedFiles: [],
      reason: "No changed files to scope-check.",
    };
  }

  const prefix = input.componentResourcePrefix.trim();
  if (!prefix) {
    return {
      status: "unmapped",
      changedFiles,
      touchedComponents: [],
      allowedComponents: [],
      missingComponents: [],
      unmappedFiles: changedFiles,
      reason: "Component resource prefix is missing; cannot evaluate scope.",
    };
  }

  if (!input.model) {
    return {
      status: "unmapped",
      changedFiles,
      touchedComponents: [],
      allowedComponents: resolveAllowedComponents(input),
      missingComponents: [],
      unmappedFiles: changedFiles,
      reason: "Control graph model unavailable; cannot evaluate scope.",
    };
  }

  const ownershipResult = resolveOwnershipFromChangedFiles({
    model: input.model,
    changedFiles,
  });
  const allowedComponents = resolveAllowedComponents(input);
  const missingComponents = ownershipResult.touchedComponents.filter(
    (componentId) => !allowedComponents.includes(componentId),
  );

  if (ownershipResult.unmappedFiles.length > 0) {
    return {
      status: "unmapped",
      changedFiles,
      touchedComponents: ownershipResult.touchedComponents,
      allowedComponents,
      missingComponents,
      unmappedFiles: ownershipResult.unmappedFiles,
      reason: formatUnmappedReason(ownershipResult.unmappedFiles),
    };
  }

  if (missingComponents.length > 0) {
    return {
      status: "out_of_scope",
      changedFiles,
      touchedComponents: ownershipResult.touchedComponents,
      allowedComponents,
      missingComponents,
      unmappedFiles: [],
      reason: formatOutOfScopeReason(missingComponents),
    };
  }

  return {
    status: "pass",
    changedFiles,
    touchedComponents: ownershipResult.touchedComponents,
    allowedComponents,
    missingComponents: [],
    unmappedFiles: [],
    reason: "Changed files are within declared/derived component scope.",
  };
}

// =============================================================================
// OWNERSHIP RESOLUTION
// =============================================================================

type OwnershipResult = {
  touchedComponents: string[];
  unmappedFiles: string[];
};

function resolveOwnershipFromChangedFiles(input: {
  model: ControlPlaneModel;
  changedFiles: string[];
}): OwnershipResult {
  const touchedComponents = new Set<string>();
  const unmappedFiles: string[] = [];

  for (const file of input.changedFiles) {
    const match = resolveOwnershipForPath(input.model.ownership, input.model.components, file);
    if (!match.owner) {
      unmappedFiles.push(match.path);
      continue;
    }

    touchedComponents.add(match.owner.component.id);
  }

  return {
    touchedComponents: Array.from(touchedComponents).sort(),
    unmappedFiles: unmappedFiles.sort(),
  };
}

// =============================================================================
// COMPONENT SCOPE
// =============================================================================

function resolveAllowedComponents(input: {
  manifest: TaskManifest;
  derivedScopeReport: DerivedScopeReport | null;
  componentResourcePrefix: string;
}): string[] {
  const prefix = input.componentResourcePrefix.trim();
  if (!prefix) {
    return [];
  }

  const declaredLocks = normalizeLocks(input.manifest.locks).writes;
  const derivedLocks = resolveDerivedWriteResources(input.derivedScopeReport);

  const declaredComponents = extractComponentIdsFromResources(declaredLocks, prefix);
  const derivedComponents = extractComponentIdsFromResources(derivedLocks, prefix);

  return dedupeAndSort([...declaredComponents, ...derivedComponents]);
}

function resolveDerivedWriteResources(report: DerivedScopeReport | null): string[] {
  if (!report) {
    return [];
  }

  if (report.derived_write_resources && report.derived_write_resources.length > 0) {
    return report.derived_write_resources;
  }

  return report.derived_locks?.writes ?? [];
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
// FORMATTING
// =============================================================================

function formatUnmappedReason(unmappedFiles: string[]): string {
  const count = unmappedFiles.length;
  const samples = unmappedFiles.slice(0, 3).join(", ");
  const suffix = count > 3 ? ` (+${count - 3} more)` : "";
  return `Missing component ownership for ${count} changed file(s): ${samples}${suffix}.`;
}

function formatOutOfScopeReason(missingComponents: string[]): string {
  const list = missingComponents.join(", ");
  return `Out-of-scope components detected: ${list}.`;
}

function normalizeChangedFiles(changedFiles: string[]): string[] {
  return dedupeAndSort(changedFiles.map((file) => file.trim()).filter(Boolean));
}

function dedupeAndSort(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
