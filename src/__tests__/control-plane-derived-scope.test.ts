import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractComponents } from "../control-plane/extract/components.js";
import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import {
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../control-plane/integration/derived-scope.js";
import { createEmptyModel, type ControlPlaneModel } from "../control-plane/model/schema.js";
import type { TaskManifest } from "../core/task-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");



// =============================================================================
// HELPERS
// =============================================================================

async function buildControlPlaneModel(repoRoot: string): Promise<ControlPlaneModel> {
  const { components } = await extractComponents(repoRoot);
  const ownership = buildOwnershipIndex(components);
  const model = createEmptyModel();
  model.components = components;
  model.ownership = ownership;
  return model;
}

function buildManifest(overrides: Partial<TaskManifest>): TaskManifest {
  return {
    id: "067",
    name: "Derived scope test",
    description: "Validate derived scope output.",
    estimated_minutes: 15,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: [] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "npm test" },
    ...overrides,
  };
}

function expectReport(
  report: DerivedScopeReport,
  expected: {
    resources: string[];
    paths?: string[];
    confidence: DerivedScopeReport["confidence"];
  },
): void {
  expect(report.derived_write_resources).toEqual(expected.resources);
  if (expected.paths) {
    expect(report.derived_write_paths).toEqual(expected.paths);
  } else {
    expect(report.derived_write_paths).toBeUndefined();
  }
  expect(report.confidence).toBe(expected.confidence);
}



// =============================================================================
// TESTS
// =============================================================================

describe("control-plane derived scope", () => {
  it("prefers component locks when present", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const manifest = buildManifest({
      locks: {
        reads: [],
        writes: ["component:acme-web-app", "component:acme-utils"],
      },
      files: {
        reads: [],
        writes: ["apps/web/src/index.ts"],
      },
    });

    const report = await deriveTaskWriteScopeReport({
      manifest,
      model,
      snapshotPath: FIXTURE_REPO,
      componentResourcePrefix: "component:",
      fallbackResource: "repo-root",
    });

    expectReport(report, {
      resources: ["component:acme-utils", "component:acme-web-app"],
      paths: ["apps/web/**", "packages/utils/**"],
      confidence: "high",
    });
    expect(report.notes).toEqual([]);
  });

  it("derives component resources from manifest write globs", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const manifest = buildManifest({
      files: {
        reads: [],
        writes: ["apps/web/src/index.ts", "packages/utils/src/index.ts"],
      },
    });

    const report = await deriveTaskWriteScopeReport({
      manifest,
      model,
      snapshotPath: FIXTURE_REPO,
      componentResourcePrefix: "component:",
      fallbackResource: "repo-root",
    });

    expectReport(report, {
      resources: ["component:acme-utils", "component:acme-web-app"],
      paths: ["apps/web/**", "packages/utils/**"],
      confidence: "medium",
    });
    expect(report.notes).toEqual([]);
  });

  it("widens to the fallback resource when ownership is missing", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const manifest = buildManifest({
      files: {
        reads: [],
        writes: ["package.json"],
      },
    });

    const report = await deriveTaskWriteScopeReport({
      manifest,
      model,
      snapshotPath: FIXTURE_REPO,
      componentResourcePrefix: "component:",
      fallbackResource: "repo-root",
    });

    expectReport(report, {
      resources: ["repo-root"],
      confidence: "low",
    });
    expect(report.notes.length).toBeGreaterThan(0);
    expect(report.notes[0]).toContain("ownership");
  });
});
