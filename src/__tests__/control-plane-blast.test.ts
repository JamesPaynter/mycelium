import { describe, expect, it } from "vitest";

import { computeBlastRadius } from "../control-plane/blast.js";
import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import type {
  ControlPlaneComponent,
  ControlPlaneDependencyEdge,
  ControlPlaneModel,
} from "../control-plane/model/schema.js";



// =============================================================================
// HELPERS
// =============================================================================

function createComponents(): ControlPlaneComponent[] {
  return [
    {
      id: "app",
      name: "app",
      roots: ["apps/app"],
      kind: "app",
    },
    {
      id: "lib",
      name: "lib",
      roots: ["packages/lib"],
      kind: "lib",
    },
    {
      id: "infra",
      name: "infra",
      roots: ["infra/terraform"],
      kind: "infra",
    },
  ];
}

function createModelWithEdges(edges: ControlPlaneDependencyEdge[]): {
  model: ControlPlaneModel;
  components: ControlPlaneComponent[];
} {
  const components = createComponents();
  const ownership = buildOwnershipIndex(components);

  return {
    model: {
      components,
      ownership,
      deps: { edges },
      symbols: [],
      symbols_ts: { definitions: [] },
    },
    components,
  };
}

function edge(
  from_component: string,
  to_component: string,
  kind: ControlPlaneDependencyEdge["kind"],
  confidence: ControlPlaneDependencyEdge["confidence"],
): ControlPlaneDependencyEdge {
  return { from_component, to_component, kind, confidence };
}

function sortComponentIds(components: ControlPlaneComponent[]): string[] {
  return components.map((component) => component.id).sort();
}



// =============================================================================
// TESTS
// =============================================================================

describe("control-plane blast radius", () => {
  it("computes touched and impacted components with high confidence", () => {
    const { model } = createModelWithEdges([
      edge("app", "lib", "workspace-package", "high"),
      edge("lib", "infra", "workspace-package", "high"),
    ]);

    const result = computeBlastRadius({
      changedPaths: ["packages/lib/src/index.ts"],
      model,
    });

    expect(result.changed_paths).toEqual(["packages/lib/src/index.ts"]);
    expect(result.touched_components).toEqual(["lib"]);
    expect(result.unmapped_paths).toEqual([]);
    expect(result.impacted_components).toEqual(["app", "lib"]);
    expect(result.confidence).toBe("high");
    expect(result.warnings).toEqual([]);
  });

  it("marks medium confidence when medium edges are used", () => {
    const { model } = createModelWithEdges([
      edge("app", "lib", "ts-import", "medium"),
    ]);

    const result = computeBlastRadius({
      changedPaths: ["packages/lib/src/index.ts"],
      model,
    });

    expect(result.touched_components).toEqual(["lib"]);
    expect(result.impacted_components).toEqual(["app", "lib"]);
    expect(result.confidence).toBe("medium");
    expect(result.warnings.join(" ").toLowerCase()).toContain("medium");
  });

  it("widens impacted components when low-confidence edges are involved", () => {
    const { model, components } = createModelWithEdges([
      edge("app", "lib", "workspace-package", "low"),
    ]);

    const result = computeBlastRadius({
      changedPaths: ["packages/lib/src/index.ts"],
      model,
    });

    expect(result.confidence).toBe("low");
    expect(result.impacted_components).toEqual(sortComponentIds(components));
    expect(result.warnings.join(" ").toLowerCase()).toContain("low");
  });

  it("widens impacted components when paths are unmapped", () => {
    const { model, components } = createModelWithEdges([]);

    const result = computeBlastRadius({
      changedPaths: ["README.md"],
      model,
    });

    expect(result.touched_components).toEqual([]);
    expect(result.unmapped_paths).toEqual(["README.md"]);
    expect(result.confidence).toBe("low");
    expect(result.impacted_components).toEqual(sortComponentIds(components));
    expect(result.warnings.join(" ").toLowerCase()).toContain("unmapped");
  });

  it("widens impacted components when dependency info is missing", () => {
    const { model, components } = createModelWithEdges([]);

    const result = computeBlastRadius({
      changedPaths: ["packages/lib/src/index.ts"],
      model,
    });

    expect(result.touched_components).toEqual(["lib"]);
    expect(result.confidence).toBe("low");
    expect(result.impacted_components).toEqual(sortComponentIds(components));
    expect(result.warnings.join(" ").toLowerCase()).toContain("dependency");
  });
});
