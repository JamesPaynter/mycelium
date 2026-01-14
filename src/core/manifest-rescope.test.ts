import { describe, expect, it } from "vitest";

import type { ManifestComplianceViolation } from "./manifest-compliance.js";
import { computeRescopeFromCompliance } from "./manifest-rescope.js";
import type { TaskManifest } from "./task-manifest.js";

describe("computeRescopeFromCompliance", () => {
  const baseManifest: TaskManifest = {
    id: "001",
    name: "sample",
    description: "Sample task",
    estimated_minutes: 10,
    dependencies: [],
    locks: { reads: [], writes: ["backend"] },
    files: { reads: [], writes: ["src/app.ts"] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "npm test" },
  };

  it("adds missing locks and files from violations", () => {
    const violations: ManifestComplianceViolation[] = [
      {
        path: "src/new-feature.ts",
        resources: ["frontend"],
        reasons: ["resource_not_locked_for_write", "file_not_declared_for_write"],
      },
    ];

    const compliance = buildCompliance(baseManifest, violations);
    const result = computeRescopeFromCompliance(baseManifest, compliance);

    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;

    expect(result.addedLocks).toEqual(["frontend"]);
    expect(result.addedFiles).toEqual(["src/new-feature.ts"]);
    expect(result.manifest.locks.writes).toEqual(["backend", "frontend"]);
    expect(result.manifest.files.writes).toEqual(["src/app.ts", "src/new-feature.ts"]);
    expect(result.manifest.files.reads).toEqual(["src/new-feature.ts"]);
  });

  it("fails when a violation cannot be mapped to a resource", () => {
    const violations: ManifestComplianceViolation[] = [
      {
        path: "config/local.env",
        resources: [],
        reasons: ["resource_unmapped", "file_not_declared_for_write"],
      },
    ];

    const compliance = buildCompliance(baseManifest, violations);
    const result = computeRescopeFromCompliance(baseManifest, compliance);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("resource mapping missing");
  });

  it("returns noop when there are no violations", () => {
    const compliance = buildCompliance(baseManifest, []);
    const result = computeRescopeFromCompliance(baseManifest, compliance);

    expect(result.status).toBe("noop");
  });
});

function buildCompliance(
  manifest: TaskManifest,
  violations: ManifestComplianceViolation[],
): Parameters<typeof computeRescopeFromCompliance>[1] {
  return {
    policy: "block",
    status: violations.length === 0 ? "pass" : "block",
    changedFiles: [],
    violations,
    report: {
      task_id: manifest.id,
      task_name: manifest.name,
      policy: "block",
      status: violations.length === 0 ? "pass" : "block",
      changed_files: [],
      violations,
      manifest: { locks: manifest.locks, files: manifest.files },
    },
  };
}
