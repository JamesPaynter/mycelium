// Control plane model schema definitions.
// Purpose: define the JSON shape and schema version for persisted models.
// Assumes higher-level builders supply data for components/ownership/deps/symbols_ts.

export const MODEL_SCHEMA_VERSION = 4;

// =============================================================================
// MODEL TYPES
// =============================================================================

export type ComponentKind = "app" | "lib" | "infra" | "unknown";

export type ControlPlaneComponent = {
  id: string;
  name: string;
  roots: string[];
  kind: ComponentKind;
  language_hints?: string[];
};

export type ControlPlaneOwnershipRoot = {
  component_id: string;
  root: string;
};

export type ControlPlaneOwnership = {
  roots: ControlPlaneOwnershipRoot[];
};

export type ControlPlaneDependencyKind = "workspace-package" | "ts-import";

export type ControlPlaneDependencyConfidence = "high" | "medium" | "low";

export type ControlPlaneDependencyEdge = {
  from_component: string;
  to_component: string;
  kind: ControlPlaneDependencyKind;
  confidence: ControlPlaneDependencyConfidence;
  evidence?: Record<string, string>;
};

export type ControlPlaneDependencies = {
  edges: ControlPlaneDependencyEdge[];
};

export type ControlPlaneSymbolDefinitionKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let";

export type ControlPlaneSymbolRange = {
  start: {
    line: number;
    column: number;
  };
  end: {
    line: number;
    column: number;
  };
  start_offset: number;
  end_offset: number;
};

export type ControlPlaneSymbolDefinition = {
  symbol_id: string;
  name: string;
  kind: ControlPlaneSymbolDefinitionKind;
  file: string;
  range: ControlPlaneSymbolRange;
  component_id: string;
};

export type ControlPlaneSymbolReference = {
  file: string;
  range: ControlPlaneSymbolRange;
  is_definition: boolean;
  component_id: string;
};

export type ControlPlaneSymbolsTs = {
  definitions: ControlPlaneSymbolDefinition[];
};

export type ControlPlaneModel = {
  components: ControlPlaneComponent[];
  ownership: ControlPlaneOwnership;
  deps: ControlPlaneDependencies;
  symbols: unknown[];
  symbols_ts: ControlPlaneSymbolsTs;
};

// =============================================================================
// MODEL INITIALIZERS
// =============================================================================

export function createEmptyModel(): ControlPlaneModel {
  return {
    components: [],
    ownership: { roots: [] },
    deps: { edges: [] },
    symbols: [],
    symbols_ts: { definitions: [] },
  };
}
