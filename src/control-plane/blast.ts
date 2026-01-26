// Control plane blast radius computation.
// Purpose: map changed paths to components and estimate impacted reverse dependencies.
// Assumes repo-relative paths use forward slashes.

import path from "node:path";

import { resolveOwnershipForPath } from "./extract/ownership.js";
import type {
  ControlPlaneComponent,
  ControlPlaneDependencyEdge,
  ControlPlaneModel,
} from "./model/schema.js";

export type ControlPlaneBlastConfidence = "high" | "medium" | "low";

export type ControlPlaneBlastResult = {
  changed_paths: string[];
  touched_components: string[];
  unmapped_paths: string[];
  impacted_components: string[];
  confidence: ControlPlaneBlastConfidence;
  warnings: string[];
};

export type ControlPlaneBlastInput = {
  changedPaths: string[];
  model: ControlPlaneModel;
};

type MappedComponents = {
  touchedComponents: string[];
  unmappedPaths: string[];
};

type ImpactedComponents = {
  impactedComponents: string[];
  usedEdges: ControlPlaneDependencyEdge[];
};

export const WARNING_UNMAPPED =
  "Unmapped paths detected; widening impacted components to all components.";
export const WARNING_MEDIUM = "Medium-confidence dependency edges included in blast radius.";
export const WARNING_LOW =
  "Low-confidence dependency edges detected; widening impacted components to all components.";
export const WARNING_MISSING_DEPS =
  "Dependency graph missing; widening impacted components to all components.";

// =============================================================================
// PUBLIC API
// =============================================================================

export function computeBlastRadius(input: ControlPlaneBlastInput): ControlPlaneBlastResult {
  const changedPaths = normalizeChangedPaths(input.changedPaths);
  const mapped = mapChangedPathsToComponents({
    changedPaths,
    components: input.model.components,
    ownershipRoots: input.model.ownership,
  });
  const warnings: string[] = [];
  const allComponents = sortComponentIds(input.model.components);

  if (mapped.unmappedPaths.length > 0) {
    warnings.push(WARNING_UNMAPPED);
    return {
      changed_paths: changedPaths,
      touched_components: mapped.touchedComponents,
      unmapped_paths: mapped.unmappedPaths,
      impacted_components: allComponents,
      confidence: "low",
      warnings,
    };
  }

  if (input.model.deps.edges.length === 0 && mapped.touchedComponents.length > 0) {
    warnings.push(WARNING_MISSING_DEPS);
    return {
      changed_paths: changedPaths,
      touched_components: mapped.touchedComponents,
      unmapped_paths: mapped.unmappedPaths,
      impacted_components: allComponents,
      confidence: "low",
      warnings,
    };
  }

  const impacted = collectImpactedComponents({
    touchedComponents: mapped.touchedComponents,
    edges: input.model.deps.edges,
  });
  const confidence = summarizeEdgeConfidence(impacted.usedEdges);

  let impactedComponents = impacted.impactedComponents;
  let confidenceLevel = confidence.level;

  if (confidence.hasLow) {
    warnings.push(WARNING_LOW);
    impactedComponents = allComponents;
    confidenceLevel = "low";
  } else if (confidence.hasMedium) {
    warnings.push(WARNING_MEDIUM);
    confidenceLevel = "medium";
  }

  return {
    changed_paths: changedPaths,
    touched_components: mapped.touchedComponents,
    unmapped_paths: mapped.unmappedPaths,
    impacted_components: impactedComponents,
    confidence: confidenceLevel,
    warnings,
  };
}

// =============================================================================
// MAPPING
// =============================================================================

function mapChangedPathsToComponents(options: {
  changedPaths: string[];
  components: ControlPlaneComponent[];
  ownershipRoots: ControlPlaneModel["ownership"];
}): MappedComponents {
  const touchedComponents = new Set<string>();
  const unmappedPaths: string[] = [];

  for (const changedPath of options.changedPaths) {
    const match = resolveOwnershipForPath(options.ownershipRoots, options.components, changedPath);

    if (!match.owner) {
      unmappedPaths.push(match.path);
      continue;
    }

    touchedComponents.add(match.owner.component.id);
  }

  return {
    touchedComponents: Array.from(touchedComponents).sort(),
    unmappedPaths: unmappedPaths.sort(),
  };
}

// =============================================================================
// IMPACTED COMPONENTS
// =============================================================================

function collectImpactedComponents(options: {
  touchedComponents: string[];
  edges: ControlPlaneDependencyEdge[];
}): ImpactedComponents {
  const impactedComponents = new Set(options.touchedComponents);
  const queue = [...options.touchedComponents];
  const usedEdges = new Map<string, ControlPlaneDependencyEdge>();
  const reverseIndex = buildReverseDependencyIndex(options.edges);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const edges = reverseIndex.get(current) ?? [];

    for (const edge of edges) {
      const edgeId = `${edge.from_component}::${edge.to_component}::${edge.kind}::${edge.confidence}`;
      if (!usedEdges.has(edgeId)) {
        usedEdges.set(edgeId, edge);
      }

      if (!impactedComponents.has(edge.from_component)) {
        impactedComponents.add(edge.from_component);
        queue.push(edge.from_component);
      }
    }
  }

  return {
    impactedComponents: Array.from(impactedComponents).sort(),
    usedEdges: Array.from(usedEdges.values()),
  };
}

function buildReverseDependencyIndex(
  edges: ControlPlaneDependencyEdge[],
): Map<string, ControlPlaneDependencyEdge[]> {
  const index = new Map<string, ControlPlaneDependencyEdge[]>();

  for (const edge of edges) {
    const list = index.get(edge.to_component);
    if (list) {
      list.push(edge);
    } else {
      index.set(edge.to_component, [edge]);
    }
  }

  return index;
}

// =============================================================================
// CONFIDENCE
// =============================================================================

function summarizeEdgeConfidence(edges: ControlPlaneDependencyEdge[]): {
  level: ControlPlaneBlastConfidence;
  hasMedium: boolean;
  hasLow: boolean;
} {
  let hasMedium = false;
  let hasLow = false;

  for (const edge of edges) {
    if (edge.confidence === "low") {
      hasLow = true;
    } else if (edge.confidence === "medium") {
      hasMedium = true;
    }
  }

  if (hasLow) {
    return { level: "low", hasMedium, hasLow };
  }

  if (hasMedium) {
    return { level: "medium", hasMedium, hasLow };
  }

  return { level: "high", hasMedium, hasLow };
}

// =============================================================================
// NORMALIZATION
// =============================================================================

function normalizeChangedPaths(changedPaths: string[]): string[] {
  const normalized = new Set<string>();

  for (const changedPath of changedPaths) {
    const trimmed = changedPath.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const normalizedPath = normalizeRepoPath(trimmed);
    if (normalizedPath.length > 0) {
      normalized.add(normalizedPath);
    }
  }

  return Array.from(normalized).sort();
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}

function sortComponentIds(components: ControlPlaneComponent[]): string[] {
  return components.map((component) => component.id).sort();
}
