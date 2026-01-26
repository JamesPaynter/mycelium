import { describe, expect, it } from "vitest";

import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import {
  computeBlastRadius,
  type ControlPlaneBlastRadiusResult,
} from "../control-plane/integration/blast-radius.js";
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
      id: "component-a",
      name: "Component A",
      roots: ["apps/component-a"],
      kind: "app",
    },
    {
      id: "component-b",
      name: "Component B",
      roots: ["packages/component-b"],
      kind: "lib",
    },
    {
      id: "component-c",
      name: "Component C",
      roots: ["packages/component-c"],
      kind: "lib",
    },
  ];
}

function createModelWithEdges(edges: ControlPlaneDependencyEdge[]): ControlPlaneModel {
  const components = createComponents();
  const ownership = buildOwnershipIndex(components);

  return {
    components,
    ownership,
    deps: { edges },
    symbols: [],
    symbols_ts: { definitions: [] },
  };
}

function createDependency(
  fromComponent: string,
  toComponent: string,
  confidence: ControlPlaneDependencyEdge["confidence"],
): ControlPlaneDependencyEdge {
  return {
    from_component: fromComponent,
    to_component: toComponent,
    kind: "workspace-package",
    confidence,
  };
}

function expectBlastResult(
  result: ControlPlaneBlastRadiusResult,
  expected: {
    touched: string[];
    impacted: string[];
    confidence: ControlPlaneBlastRadiusResult["confidence"];
    reasons: ControlPlaneBlastRadiusResult["widening_reasons"];
  },
): void {
  expect(result.touched_components).toEqual(expected.touched);
  expect(result.impacted_components).toEqual(expected.impacted);
  expect(result.confidence).toBe(expected.confidence);
  expect(result.widening_reasons).toEqual(expected.reasons);
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane blast radius integration", () => {
  it("computes impacted components from reverse dependencies", () => {
    const model = createModelWithEdges([
      createDependency("component-b", "component-a", "high"),
      createDependency("component-c", "component-b", "high"),
    ]);

    const blastForC = computeBlastRadius({
      baseSha: "base-sha",
      changedFiles: ["packages/component-c/src/index.ts"],
      model,
    });

    expectBlastResult(blastForC, {
      touched: ["component-c"],
      impacted: ["component-c"],
      confidence: "high",
      reasons: [],
    });

    const blastForB = computeBlastRadius({
      baseSha: "base-sha",
      changedFiles: ["packages/component-b/src/index.ts"],
      model,
    });

    expectBlastResult(blastForB, {
      touched: ["component-b"],
      impacted: ["component-b", "component-c"],
      confidence: "high",
      reasons: [],
    });

    const blastForA = computeBlastRadius({
      baseSha: "base-sha",
      changedFiles: ["apps/component-a/src/index.ts"],
      model,
    });

    expectBlastResult(blastForA, {
      touched: ["component-a"],
      impacted: ["component-a", "component-b", "component-c"],
      confidence: "high",
      reasons: [],
    });
  });

  it("widens when low-confidence edges are involved", () => {
    const model = createModelWithEdges([createDependency("component-b", "component-a", "low")]);

    const result = computeBlastRadius({
      baseSha: "base-sha",
      changedFiles: ["apps/component-a/src/index.ts"],
      model,
    });

    expect(result.confidence).toBe("low");
    expect(result.widening_reasons).toEqual(["low_confidence_edges"]);
    expect(result.impacted_components).toEqual(["component-a", "component-b", "component-c"]);
  });
});
