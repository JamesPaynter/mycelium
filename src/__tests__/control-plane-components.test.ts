import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractComponents } from "../control-plane/extract/components.js";
import {
  buildOwnershipIndex,
  resolveOwnershipForPath,
} from "../control-plane/extract/ownership.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_FIXTURE = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const FLAT_FIXTURE = path.resolve(__dirname, "../../test/fixtures/control-plane-flat-repo");

// =============================================================================
// COMPONENT EXTRACTION
// =============================================================================

describe("control-plane component extraction", () => {
  it("extracts workspace components with heuristics", async () => {
    const result = await extractComponents(WORKSPACE_FIXTURE);

    expect(result.source).toBe("workspaces");
    expect(result.components).toEqual([
      {
        id: "acme-web-app",
        name: "@acme/web-app",
        roots: ["apps/web"],
        kind: "app",
        language_hints: ["ts"],
      },
      {
        id: "acme-infra-terraform",
        name: "@acme/infra-terraform",
        roots: ["infra/terraform"],
        kind: "infra",
        language_hints: ["js"],
      },
      {
        id: "acme-utils",
        name: "@acme/utils",
        roots: ["packages/utils"],
        kind: "lib",
        language_hints: ["ts"],
      },
    ]);
  });

  it("falls back to top-level directories when workspaces are missing", async () => {
    const result = await extractComponents(FLAT_FIXTURE);

    expect(result.source).toBe("directories");
    expect(result.components).toEqual([
      {
        id: "apps",
        name: "apps",
        roots: ["apps"],
        kind: "app",
        language_hints: ["py"],
      },
      {
        id: "docs",
        name: "docs",
        roots: ["docs"],
        kind: "unknown",
      },
      {
        id: "lib",
        name: "lib",
        roots: ["lib"],
        kind: "lib",
        language_hints: ["go"],
      },
    ]);
  });
});

// =============================================================================
// OWNERSHIP LOOKUPS
// =============================================================================

describe("control-plane ownership", () => {
  it("resolves owners by the longest matching root", async () => {
    const { components } = await extractComponents(WORKSPACE_FIXTURE);
    const ownership = buildOwnershipIndex(components);

    const appMatch = resolveOwnershipForPath(ownership, components, "apps/web/src/index.ts");
    expect(appMatch.owner?.component.id).toBe("acme-web-app");
    expect(appMatch.owner?.root).toBe("apps/web");
    expect(appMatch.candidates).toHaveLength(1);

    const utilMatch = resolveOwnershipForPath(ownership, components, "packages/utils/src/index.ts");
    expect(utilMatch.owner?.component.id).toBe("acme-utils");
    expect(utilMatch.owner?.root).toBe("packages/utils");
    expect(utilMatch.candidates).toHaveLength(1);

    const noMatch = resolveOwnershipForPath(ownership, components, "README.md");
    expect(noMatch.owner).toBeNull();
    expect(noMatch.candidates).toHaveLength(0);
  });
});
