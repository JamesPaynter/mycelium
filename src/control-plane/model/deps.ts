// Control plane dependency layer helpers.
// Purpose: merge dependency edges, build query indices, and resolve deps/rdeps output.
// Assumes component ids are stable across extractors.

import type {
  ControlPlaneComponent,
  ControlPlaneDependencies,
  ControlPlaneDependencyEdge,
} from "./schema.js";
import { extractWorkspacePackageDependencyEdges } from "../extract/deps-packages.js";
import { extractTypeScriptImportDependencyEdges } from "../extract/deps-ts-imports.js";

export type ControlPlaneDependencyQueryResult = {
  component_id: string;
  edges: ControlPlaneDependencyEdge[];
  transitive: boolean;
  limit: number | null;
  truncated: boolean;
};

type DependencyIndex = {
  forward: Map<string, ControlPlaneDependencyEdge[]>;
  reverse: Map<string, ControlPlaneDependencyEdge[]>;
};

const CONFIDENCE_ORDER: Record<ControlPlaneDependencyEdge["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const KIND_ORDER: Record<ControlPlaneDependencyEdge["kind"], number> = {
  "workspace-package": 0,
  "ts-import": 1,
};

// =============================================================================
// BUILD HELPERS
// =============================================================================

export async function buildControlPlaneDependencies(options: {
  repoRoot: string;
  components: ControlPlaneComponent[];
}): Promise<ControlPlaneDependencies> {
  const [packageEdges, importEdges] = await Promise.all([
    extractWorkspacePackageDependencyEdges({
      repoRoot: options.repoRoot,
      components: options.components,
    }),
    extractTypeScriptImportDependencyEdges({
      repoRoot: options.repoRoot,
      components: options.components,
    }),
  ]);

  const edges = mergeDependencyEdges([...packageEdges, ...importEdges]);
  return { edges };
}

// =============================================================================
// QUERY HELPERS
// =============================================================================

export function resolveComponentDependencies(options: {
  componentId: string;
  edges: ControlPlaneDependencyEdge[];
  transitive?: boolean;
  limit?: number | null;
}): ControlPlaneDependencyQueryResult {
  const transitive = options.transitive ?? false;
  const limit = normalizeLimit(options.limit);
  const index = buildDependencyIndex(options.edges);

  const edges = transitive
    ? collectTransitiveEdges(index, options.componentId, "forward")
    : (index.forward.get(options.componentId) ?? []);

  return finalizeQueryResult(options.componentId, edges, transitive, limit);
}

export function resolveComponentReverseDependencies(options: {
  componentId: string;
  edges: ControlPlaneDependencyEdge[];
  transitive?: boolean;
  limit?: number | null;
}): ControlPlaneDependencyQueryResult {
  const transitive = options.transitive ?? false;
  const limit = normalizeLimit(options.limit);
  const index = buildDependencyIndex(options.edges);

  const edges = transitive
    ? collectTransitiveEdges(index, options.componentId, "reverse")
    : (index.reverse.get(options.componentId) ?? []);

  return finalizeQueryResult(options.componentId, edges, transitive, limit);
}

// =============================================================================
// INDEX + TRAVERSAL
// =============================================================================

function buildDependencyIndex(edges: ControlPlaneDependencyEdge[]): DependencyIndex {
  const forward = new Map<string, ControlPlaneDependencyEdge[]>();
  const reverse = new Map<string, ControlPlaneDependencyEdge[]>();

  for (const edge of edges) {
    const forwardList = forward.get(edge.from_component);
    if (forwardList) {
      forwardList.push(edge);
    } else {
      forward.set(edge.from_component, [edge]);
    }

    const reverseList = reverse.get(edge.to_component);
    if (reverseList) {
      reverseList.push(edge);
    } else {
      reverse.set(edge.to_component, [edge]);
    }
  }

  return { forward, reverse };
}

function collectTransitiveEdges(
  index: DependencyIndex,
  startComponentId: string,
  direction: "forward" | "reverse",
): ControlPlaneDependencyEdge[] {
  const queue = [startComponentId];
  const visited = new Set<string>(queue);
  const collected = new Map<string, ControlPlaneDependencyEdge>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const edges =
      direction === "forward"
        ? (index.forward.get(current) ?? [])
        : (index.reverse.get(current) ?? []);

    for (const edge of edges) {
      const key = `${edge.from_component}::${edge.to_component}::${edge.kind}::${edge.confidence}`;
      if (!collected.has(key)) {
        collected.set(key, edge);
      }

      const nextComponent = direction === "forward" ? edge.to_component : edge.from_component;
      if (!visited.has(nextComponent)) {
        visited.add(nextComponent);
        queue.push(nextComponent);
      }
    }
  }

  return Array.from(collected.values());
}

// =============================================================================
// MERGE + SORT
// =============================================================================

function mergeDependencyEdges(edges: ControlPlaneDependencyEdge[]): ControlPlaneDependencyEdge[] {
  const merged = new Map<string, ControlPlaneDependencyEdge>();

  for (const edge of edges) {
    const key = `${edge.from_component}::${edge.to_component}::${edge.kind}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, edge);
      continue;
    }

    if (confidenceRank(edge.confidence) < confidenceRank(existing.confidence)) {
      merged.set(key, edge);
    }
  }

  return sortDependencyEdges(Array.from(merged.values()));
}

function sortDependencyEdges(edges: ControlPlaneDependencyEdge[]): ControlPlaneDependencyEdge[] {
  return [...edges].sort(compareDependencyEdges);
}

function compareDependencyEdges(
  left: ControlPlaneDependencyEdge,
  right: ControlPlaneDependencyEdge,
): number {
  if (left.from_component !== right.from_component) {
    return left.from_component.localeCompare(right.from_component);
  }

  if (left.to_component !== right.to_component) {
    return left.to_component.localeCompare(right.to_component);
  }

  if (left.kind !== right.kind) {
    return kindRank(left.kind) - kindRank(right.kind);
  }

  if (left.confidence !== right.confidence) {
    return confidenceRank(left.confidence) - confidenceRank(right.confidence);
  }

  return 0;
}

function kindRank(kind: ControlPlaneDependencyEdge["kind"]): number {
  return KIND_ORDER[kind] ?? 99;
}

function confidenceRank(confidence: ControlPlaneDependencyEdge["confidence"]): number {
  return CONFIDENCE_ORDER[confidence] ?? 99;
}

// =============================================================================
// QUERY OUTPUT
// =============================================================================

function finalizeQueryResult(
  componentId: string,
  edges: ControlPlaneDependencyEdge[],
  transitive: boolean,
  limit: number | null,
): ControlPlaneDependencyQueryResult {
  const sorted = sortDependencyEdges(edges);
  const { limited, truncated } = applyLimit(sorted, limit);

  return {
    component_id: componentId,
    edges: limited,
    transitive,
    limit,
    truncated,
  };
}

function normalizeLimit(limit?: number | null): number | null {
  if (limit === undefined || limit === null) {
    return null;
  }

  if (!Number.isFinite(limit)) {
    return null;
  }

  const normalized = Math.floor(limit);
  return normalized >= 1 ? normalized : null;
}

function applyLimit(
  edges: ControlPlaneDependencyEdge[],
  limit: number | null,
): { limited: ControlPlaneDependencyEdge[]; truncated: boolean } {
  if (!limit) {
    return { limited: edges, truncated: false };
  }

  if (edges.length <= limit) {
    return { limited: edges, truncated: false };
  }

  return { limited: edges.slice(0, limit), truncated: true };
}
