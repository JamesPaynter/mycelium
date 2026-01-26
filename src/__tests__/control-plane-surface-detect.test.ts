import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractComponents } from "../control-plane/extract/components.js";
import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import {
  associateSurfaceChangesWithComponents,
  detectSurfaceChanges,
} from "../control-plane/policy/surface-detect.js";
import { createEmptyModel, type ControlPlaneModel } from "../control-plane/model/schema.js";

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

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane surface detection", () => {
  it("categorizes changed files with default surface patterns", () => {
    const result = detectSurfaceChanges([
      "api/openapi.yaml",
      "proto/service.proto",
      ".env.local",
      "config/app.yaml",
      "deploy/values.yaml",
      "db/migrations/20240101_init.sql",
      "src/migration/001/step.sql",
      "src/index.ts",
      "package.json",
      "docs/readme.md",
    ]);

    expect(result.is_surface_change).toBe(true);
    expect(result.categories).toEqual(["contract", "config", "migration", "public-entrypoint"]);

    expect(result.matched_files.contract).toEqual(["api/openapi.yaml", "proto/service.proto"]);
    expect(result.matched_files.config).toEqual([
      ".env.local",
      "config/app.yaml",
      "deploy/values.yaml",
    ]);
    expect(result.matched_files.migration).toEqual([
      "db/migrations/20240101_init.sql",
      "src/migration/001/step.sql",
    ]);
    expect(result.matched_files["public-entrypoint"]).toEqual(["package.json", "src/index.ts"]);
  });

  it("returns an empty detection when no files match", () => {
    const result = detectSurfaceChanges(["docs/readme.md", "src/utils/helpers.ts"]);

    expect(result.is_surface_change).toBe(false);
    expect(result.categories).toEqual([]);
    expect(result.matched_files).toEqual({});
  });

  it("associates surface matches with components", async () => {
    const model = await buildControlPlaneModel(FIXTURE_REPO);
    const detection = detectSurfaceChanges([
      "apps/web/src/index.ts",
      "packages/utils/src/index.ts",
      "docs/readme.md",
    ]);

    const associated = associateSurfaceChangesWithComponents({
      detection,
      model,
    });

    expect(associated.matched_components).toEqual(["acme-utils", "acme-web-app"]);
    expect(associated.matched_components_by_category).toEqual({
      "public-entrypoint": ["acme-utils", "acme-web-app"],
    });
  });
});
