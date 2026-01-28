import { describe, expect, it } from "vitest";

import type { DerivedScopeReport } from "../control-plane/integration/derived-scope.js";
import {
  evaluateTaskPolicyDecision,
  type PolicyChecksetConfig,
} from "../control-plane/policy/eval.js";
import type { SurfacePatternSet } from "../control-plane/policy/types.js";
import type { TaskManifest } from "../core/task-manifest.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

const EMPTY_SURFACE_PATTERNS: SurfacePatternSet = {
  contract: [],
  config: [],
  migration: [],
  "public-entrypoint": [],
};

const BASE_MANIFEST: TaskManifest = {
  id: "405",
  name: "Scoped checks",
  description: "Test manifest",
  estimated_minutes: 10,
  dependencies: [],
  locks: { reads: [], writes: [] },
  files: { reads: [], writes: [] },
  affected_tests: [],
  test_paths: [],
  tdd_mode: "off",
  verify: { doctor: "npm test" },
};

const BASE_CHECKS_CONFIG: PolicyChecksetConfig = {
  mode: "off",
  commandsByComponent: {},
  maxComponentsForScoped: 3,
};

function buildDerivedScopeReport(overrides: Partial<DerivedScopeReport>): DerivedScopeReport {
  return {
    task_id: BASE_MANIFEST.id,
    task_name: BASE_MANIFEST.name,
    derived_write_resources: [],
    derived_locks: { reads: [], writes: [] },
    confidence: "high",
    notes: [],
    manifest: {
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane policy evaluation", () => {
  it("prefers derived component scope when available", () => {
    const manifest: TaskManifest = {
      ...BASE_MANIFEST,
      locks: { reads: [], writes: ["component:component-b"] },
    };
    const derivedScopeReport = buildDerivedScopeReport({
      derived_write_resources: ["component:component-a"],
    });

    const result = evaluateTaskPolicyDecision({
      task: manifest,
      derivedScopeReport,
      componentResourcePrefix: "component:",
      fallbackResource: "repo-root",
      model: null,
      checksConfig: BASE_CHECKS_CONFIG,
      defaultDoctorCommand: "npm test",
      surfacePatterns: EMPTY_SURFACE_PATTERNS,
    });

    expect(result.touchedComponents).toEqual(["component-a"]);
    expect(result.checksetDecision.required_components).toEqual(["component-a"]);
  });

  it("falls back to declared locks when derived scope is missing components", () => {
    const manifest: TaskManifest = {
      ...BASE_MANIFEST,
      locks: { reads: [], writes: ["component:component-b"] },
    };
    const derivedScopeReport = buildDerivedScopeReport({
      derived_write_resources: ["repo-root"],
    });

    const result = evaluateTaskPolicyDecision({
      task: manifest,
      derivedScopeReport,
      componentResourcePrefix: "component:",
      fallbackResource: "repo-root",
      model: null,
      checksConfig: BASE_CHECKS_CONFIG,
      defaultDoctorCommand: "npm test",
      surfacePatterns: EMPTY_SURFACE_PATTERNS,
    });

    expect(result.touchedComponents).toEqual(["component-b"]);
    expect(result.checksetDecision.required_components).toEqual(["component-b"]);
  });
});
