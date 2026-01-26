/**
 * CompliancePipeline unit tests.
 * Purpose: validate policy resolution and rescope plan decisions.
 * Assumptions: compliance inputs are synthesized (no filesystem I/O).
 * Usage: npm test -- src/app/orchestrator/compliance/compliance-pipeline.test.ts
 */

import { describe, expect, it } from "vitest";

import type {
  ManifestComplianceResult,
  ManifestComplianceViolation,
} from "../../../core/manifest-compliance.js";
import type { TaskManifest } from "../../../core/task-manifest.js";

import {
  buildComplianceRescopePlan,
  resolveCompliancePolicyForTier,
} from "./compliance-pipeline.js";

// =============================================================================
// HELPERS
// =============================================================================

const BASE_MANIFEST: TaskManifest = {
  id: "001",
  name: "compliance-task",
  description: "Compliance pipeline test task",
  estimated_minutes: 5,
  dependencies: [],
  locks: { reads: [], writes: ["backend"] },
  files: { reads: [], writes: ["src/app.ts"] },
  affected_tests: [],
  test_paths: [],
  tdd_mode: "off",
  verify: { doctor: "npm test" },
};

function buildComplianceResult(
  manifest: TaskManifest,
  violations: ManifestComplianceViolation[],
): ManifestComplianceResult {
  const status = violations.length === 0 ? "pass" : "block";
  return {
    policy: "block",
    status,
    changedFiles: [],
    violations,
    report: {
      task_id: manifest.id,
      task_name: manifest.name,
      policy: "block",
      status,
      changed_files: [],
      violations,
      manifest: { locks: manifest.locks, files: manifest.files },
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("resolveCompliancePolicyForTier", () => {
  it("upgrades warn to block for higher tiers", () => {
    expect(resolveCompliancePolicyForTier({ basePolicy: "warn", tier: 2 })).toBe("block");
    expect(resolveCompliancePolicyForTier({ basePolicy: "warn", tier: 1 })).toBe("warn");
    expect(resolveCompliancePolicyForTier({ basePolicy: "off", tier: 3 })).toBe("off");
    expect(resolveCompliancePolicyForTier({ basePolicy: "block", tier: 0 })).toBe("block");
  });
});

describe("buildComplianceRescopePlan", () => {
  const violations: ManifestComplianceViolation[] = [
    {
      path: "src/new-file.ts",
      resources: ["frontend"],
      reasons: ["resource_not_locked_for_write", "file_not_declared_for_write"],
    },
  ];

  it("skips rescope when enforcement is disabled", () => {
    const compliance = buildComplianceResult(BASE_MANIFEST, violations);
    const plan = buildComplianceRescopePlan({
      compliance,
      manifest: BASE_MANIFEST,
      shouldEnforce: false,
    });

    expect(plan.status).toBe("skipped");
  });

  it("builds a rescope plan when enforcement is enabled", () => {
    const compliance = buildComplianceResult(BASE_MANIFEST, violations);
    const plan = buildComplianceRescopePlan({
      compliance,
      manifest: BASE_MANIFEST,
      shouldEnforce: true,
    });

    expect(plan.status).toBe("required");
    if (plan.status !== "required") return;
    expect(plan.rescope.status).toBe("updated");
    if (plan.rescope.status !== "updated") return;
    expect(plan.rescope.addedLocks).toEqual(["frontend"]);
    expect(plan.rescope.addedFiles).toEqual(["src/new-file.ts"]);
  });
});
