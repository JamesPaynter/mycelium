// Control plane checkset policy.
// Purpose: compute scoped doctor commands from component scope with conservative widening.
// Assumes component IDs are normalized (no resource prefix).

import type { ControlPlaneDependencyEdge, ControlPlaneModel } from "../model/schema.js";
import type { SurfaceChangeCategory } from "./types.js";

export type ChecksetMode = "off" | "report" | "enforce";

export type ChecksetConfidence = "high" | "medium" | "low";

export type ChecksetFallbackReason =
  | "surface_change"
  | "no_components"
  | "too_many_components"
  | "missing_command_mapping";

export type ChecksetWideningReason =
  | "missing_dependency_graph"
  | "low_confidence_edges";

export type ChecksetImpactAssessment = {
  impactedComponents: string[];
  confidence: ChecksetConfidence;
  wideningReasons: ChecksetWideningReason[];
};

export type ChecksetDecision = {
  required_components: string[];
  selected_command: string;
  is_fallback: boolean;
  fallback_reason?: ChecksetFallbackReason;
  confidence: ChecksetConfidence;
  rationale: string[];
};

export type ChecksetDecisionInput = {
  touchedComponents: string[];
  impactedComponents?: string[];
  impactConfidence?: ChecksetConfidence;
  impactWideningReasons?: ChecksetWideningReason[];
  commandsByComponent: Record<string, string>;
  maxComponentsForScoped: number;
  fallbackCommand: string;
  surfaceChange?: boolean;
  surfaceChangeCategories?: SurfaceChangeCategory[];
};



// =============================================================================
// PUBLIC API
// =============================================================================

export function computeChecksetImpactFromGraph(input: {
  touchedComponents: string[];
  model: ControlPlaneModel;
}): ChecksetImpactAssessment {
  const touchedComponents = normalizeComponentIds(input.touchedComponents);
  const allComponents = normalizeComponentIds(
    input.model.components.map((component) => component.id),
  );

  if (touchedComponents.length === 0) {
    return { impactedComponents: [], confidence: "low", wideningReasons: [] };
  }

  if (input.model.deps.edges.length === 0) {
    return {
      impactedComponents: widenToAllComponents(allComponents, touchedComponents),
      confidence: "low",
      wideningReasons: ["missing_dependency_graph"],
    };
  }

  const impacted = collectImpactedComponents({
    touchedComponents,
    edges: input.model.deps.edges,
  });
  const edgeConfidence = summarizeEdgeConfidence(impacted.usedEdges);

  if (edgeConfidence.hasLow) {
    return {
      impactedComponents: widenToAllComponents(allComponents, touchedComponents),
      confidence: "low",
      wideningReasons: ["low_confidence_edges"],
    };
  }

  return {
    impactedComponents: impacted.impactedComponents,
    confidence: edgeConfidence.hasMedium ? "medium" : "high",
    wideningReasons: [],
  };
}

export function computeChecksetDecision(input: ChecksetDecisionInput): ChecksetDecision {
  const touchedComponents = normalizeComponentIds(input.touchedComponents);
  const requiredComponents = normalizeComponentIds(
    input.impactedComponents ?? touchedComponents,
  );
  const normalizedCommandMap = normalizeCommandMapping(input.commandsByComponent);
  const rationale: string[] = [];

  if (input.impactWideningReasons && input.impactWideningReasons.length > 0) {
    rationale.push(`impact_widened:${input.impactWideningReasons.join(",")}`);
  }

  if (input.surfaceChange) {
    rationale.push(buildSurfaceChangeSummary(input.surfaceChangeCategories));
    if (!input.impactedComponents || input.impactedComponents.length === 0) {
      return buildFallbackDecision({
        fallbackCommand: input.fallbackCommand,
        requiredComponents,
        rationale,
        reason: "surface_change",
      });
    }
  }

  if (requiredComponents.length === 0) {
    return buildFallbackDecision({
      fallbackCommand: input.fallbackCommand,
      requiredComponents,
      rationale,
      reason: "no_components",
    });
  }

  if (requiredComponents.length > input.maxComponentsForScoped) {
    return buildFallbackDecision({
      fallbackCommand: input.fallbackCommand,
      requiredComponents,
      rationale,
      reason: "too_many_components",
    });
  }

  const missingMappings = requiredComponents.filter(
    (componentId) => !normalizedCommandMap[componentId],
  );
  if (missingMappings.length > 0) {
    rationale.push(`missing_mappings:${missingMappings.join(",")}`);
    return buildFallbackDecision({
      fallbackCommand: input.fallbackCommand,
      requiredComponents,
      rationale,
      reason: "missing_command_mapping",
    });
  }

  const scopedCommands = buildScopedCommands({
    requiredComponents,
    commandsByComponent: normalizedCommandMap,
  });
  const selectedCommand = scopedCommands.join(" && ");
  const confidence = input.impactConfidence ?? "high";

  if (confidence !== "high") {
    rationale.push(`impact_confidence:${confidence}`);
  }

  return {
    required_components: requiredComponents,
    selected_command: selectedCommand,
    is_fallback: false,
    confidence,
    rationale,
  };
}

export function resolveDoctorCommandForChecksetMode(input: {
  mode: ChecksetMode;
  decision: ChecksetDecision;
  defaultDoctorCommand: string;
}): string {
  if (input.mode !== "enforce") {
    return input.defaultDoctorCommand;
  }

  return input.decision.selected_command;
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

type ImpactedComponents = {
  impactedComponents: string[];
  usedEdges: ControlPlaneDependencyEdge[];
};

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

function summarizeEdgeConfidence(edges: ControlPlaneDependencyEdge[]): {
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

  return { hasMedium, hasLow };
}

function normalizeComponentIds(components: string[]): string[] {
  const normalized = components.map((component) => component.trim()).filter((component) => {
    return component.length > 0;
  });

  return Array.from(new Set(normalized)).sort();
}

function normalizeCommandMapping(
  commandsByComponent: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(commandsByComponent)
      .map(([componentId, command]) => [componentId.trim(), command.trim()] as const)
      .filter(([componentId, command]) => componentId.length > 0 && command.length > 0),
  );
}

function buildSurfaceChangeSummary(categories?: SurfaceChangeCategory[]): string {
  const normalized = normalizeSurfaceCategories(categories);
  if (normalized.length === 0) {
    return "surface_change:unknown";
  }

  return `surface_change:${normalized.join(",")}`;
}

function normalizeSurfaceCategories(categories?: SurfaceChangeCategory[]): string[] {
  if (!categories || categories.length === 0) {
    return [];
  }

  const normalized = categories.map((category) => category.trim()).filter((category) => {
    return category.length > 0;
  });

  return Array.from(new Set(normalized)).sort();
}

function buildScopedCommands(input: {
  requiredComponents: string[];
  commandsByComponent: Record<string, string>;
}): string[] {
  const uniqueCommands: string[] = [];
  const seen = new Set<string>();

  for (const componentId of input.requiredComponents) {
    const command = input.commandsByComponent[componentId];
    if (!command || seen.has(command)) {
      continue;
    }

    seen.add(command);
    uniqueCommands.push(command);
  }

  return uniqueCommands;
}

function widenToAllComponents(allComponents: string[], touchedComponents: string[]): string[] {
  return normalizeComponentIds([...allComponents, ...touchedComponents]);
}

function buildFallbackDecision(input: {
  fallbackCommand: string;
  requiredComponents: string[];
  rationale: string[];
  reason: ChecksetFallbackReason;
}): ChecksetDecision {
  input.rationale.push(`fallback:${input.reason}`);

  return {
    required_components: input.requiredComponents,
    selected_command: input.fallbackCommand,
    is_fallback: true,
    fallback_reason: input.reason,
    confidence: "low",
    rationale: input.rationale,
  };
}
