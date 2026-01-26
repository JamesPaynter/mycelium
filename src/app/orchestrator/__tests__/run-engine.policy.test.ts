/**
 * RunEngine helper tests.
 * Purpose: validate scope resolution and task failure policy mapping.
 */

import { describe, expect, it } from "vitest";

import { resolveSurfacePatterns } from "../../../control-plane/policy/surface-detect.js";
import type { TaskFailurePolicy } from "../../../core/config.js";
import { resolveScopeComplianceMode, shouldResetTaskToPending } from "../run/run-engine.js";
import type { ControlPlaneRunConfig } from "../run-context.js";
import type { WorkerRunnerResult } from "../workers/worker-runner.js";

// =============================================================================
// HELPERS
// =============================================================================

function buildControlPlaneConfig(
  overrides: Partial<ControlPlaneRunConfig> = {},
): ControlPlaneRunConfig {
  return {
    enabled: false,
    componentResourcePrefix: "component:",
    fallbackResource: "repo-root",
    resourcesMode: "prefer-derived",
    scopeMode: "shadow",
    lockMode: "declared",
    checks: {
      mode: "off",
      commandsByComponent: {},
      maxComponentsForScoped: 3,
    },
    surfacePatterns: resolveSurfacePatterns(),
    surfaceLocksEnabled: false,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("run-engine helpers", () => {
  it("honors scope_mode even when control plane is disabled", () => {
    const config = buildControlPlaneConfig({ enabled: false, scopeMode: "shadow" });

    expect(resolveScopeComplianceMode(config)).toBe("shadow");
  });

  it("maps retry policy to reset-to-pending on worker failures", () => {
    const result: WorkerRunnerResult = { success: false, errorMessage: "boom" };
    const policy: TaskFailurePolicy = "retry";

    expect(shouldResetTaskToPending({ policy, result })).toBe(true);
  });

  it("keeps fail_fast policy as task failure on worker failures", () => {
    const result: WorkerRunnerResult = { success: false, errorMessage: "boom" };
    const policy: TaskFailurePolicy = "fail_fast";

    expect(shouldResetTaskToPending({ policy, result })).toBe(false);
  });
});
