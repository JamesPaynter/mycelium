import { describe, expect, it } from "vitest";

import type { TaskManifest } from "../../core/task-manifest.js";
import { buildOwnershipIndex } from "../extract/ownership.js";
import type { ControlPlaneComponent, ControlPlaneModel } from "../model/schema.js";

import type { TaskChangeManifest } from "./change-manifest.js";
import { evaluateControlGraphScope } from "./scope-enforcement.js";

// =============================================================================
// HELPERS
// =============================================================================

const COMPONENT_RESOURCE_PREFIX = "component:";

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
      roots: ["apps/component-b"],
      kind: "app",
    },
  ];
}

function createModel(): ControlPlaneModel {
  const components = createComponents();
  const ownership = buildOwnershipIndex(components);

  return {
    components,
    ownership,
    deps: { edges: [] },
    symbols: [],
    symbols_ts: { definitions: [] },
  };
}

function createManifest(overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    id: "401",
    name: "Scope Enforcement",
    description: "Test manifest for control graph scope enforcement.",
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: ["component:component-a"] },
    files: { reads: [], writes: ["apps/component-a/owned.ts"] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "npm test" },
    ...overrides,
  };
}

function createChangeManifest(changedFiles: string[]): TaskChangeManifest {
  return {
    task_id: "401",
    task_name: "Scope Enforcement",
    base_sha: "base-sha",
    head_sha: "head-sha",
    changed_files: changedFiles,
    touched_components: [],
    impacted_components: [],
    surface_change: { is_surface_change: false, categories: [], matched_files: {} },
    notes: [],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("control graph scope enforcement", () => {
  it("flags component drift outside allowed locks", () => {
    const model = createModel();
    const manifest = createManifest();
    const changeManifest = createChangeManifest(["apps/component-b/new.ts"]);

    const evaluation = evaluateControlGraphScope({
      manifest,
      derivedScopeReport: null,
      changeManifest,
      componentResourcePrefix: COMPONENT_RESOURCE_PREFIX,
      model,
    });

    expect(evaluation.status).toBe("out_of_scope");
    expect(evaluation.missingComponents).toEqual(["component-b"]);
    expect(evaluation.unmappedFiles).toEqual([]);
  });

  it("flags unmapped files when ownership is missing", () => {
    const model = createModel();
    const manifest = createManifest();
    const changeManifest = createChangeManifest(["docs/README.md"]);

    const evaluation = evaluateControlGraphScope({
      manifest,
      derivedScopeReport: null,
      changeManifest,
      componentResourcePrefix: COMPONENT_RESOURCE_PREFIX,
      model,
    });

    expect(evaluation.status).toBe("unmapped");
    expect(evaluation.unmappedFiles).toEqual(["docs/README.md"]);
  });

  it("passes when changed files stay within allowed components", () => {
    const model = createModel();
    const manifest = createManifest();
    const changeManifest = createChangeManifest(["apps/component-a/owned.ts"]);

    const evaluation = evaluateControlGraphScope({
      manifest,
      derivedScopeReport: null,
      changeManifest,
      componentResourcePrefix: COMPONENT_RESOURCE_PREFIX,
      model,
    });

    expect(evaluation.status).toBe("pass");
    expect(evaluation.missingComponents).toEqual([]);
  });
});
