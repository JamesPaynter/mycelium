import { afterEach, describe, expect, it, vi } from "vitest";

import { buildControlPlaneModel } from "../control-plane/model/build.js";
import type {
  ControlPlaneComponent,
  ControlPlaneDependencyEdge,
} from "../control-plane/model/schema.js";

import {
  cleanupTempDirs,
  createControlPlaneRunner,
  createTempRepoFromFixture,
  edge,
  EXPECTED_COMPONENTS,
  expectOk,
  expectedComponentById,
  type SymbolDefinitionResult,
  type SymbolFindResult,
  type SymbolReferencesResult,
} from "./control-plane-acceptance.helpers.js";

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane acceptance", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    await cleanupTempDirs();
  });

  it("returns stable component and ownership results", async () => {
    const repoDir = await createTempRepoFromFixture();
    await buildControlPlaneModel({ repoRoot: repoDir });

    const runJson = createControlPlaneRunner(repoDir);

    const components = expectOk<ControlPlaneComponent[]>(
      await runJson<ControlPlaneComponent[]>(["components", "list"]),
    );
    expect(components).toEqual(EXPECTED_COMPONENTS);

    const webComponent = expectOk<ControlPlaneComponent | null>(
      await runJson<ControlPlaneComponent | null>(["components", "show", "acme-web-app"]),
    );
    expect(webComponent).toEqual(expectedComponentById("acme-web-app"));

    const owner = expectOk<{
      path: string;
      owner: { component: ControlPlaneComponent; root: string } | null;
      candidates: Array<{ component: ControlPlaneComponent; root: string }>;
    }>(
      await runJson<{
        path: string;
        owner: { component: ControlPlaneComponent; root: string } | null;
        candidates: Array<{ component: ControlPlaneComponent; root: string }>;
      }>(["owner", "apps/web/src/index.ts"]),
    );

    expect(owner).toEqual({
      path: "apps/web/src/index.ts",
      owner: {
        component: expectedComponentById("acme-web-app"),
        root: "apps/web",
      },
      candidates: [
        {
          component: expectedComponentById("acme-web-app"),
          root: "apps/web",
        },
      ],
    });
  });

  it("returns stable dependency and blast outputs", async () => {
    const repoDir = await createTempRepoFromFixture();
    await buildControlPlaneModel({ repoRoot: repoDir });

    const runJson = createControlPlaneRunner(repoDir);

    const deps = expectOk<{
      component_id: string;
      edges: ControlPlaneDependencyEdge[];
      transitive: boolean;
      limit: number | null;
      truncated: boolean;
    }>(
      await runJson<{
        component_id: string;
        edges: ControlPlaneDependencyEdge[];
        transitive: boolean;
        limit: number | null;
        truncated: boolean;
      }>(["deps", "acme-web-app"]),
    );

    expect(deps).toEqual({
      component_id: "acme-web-app",
      edges: [
        edge("acme-web-app", "acme-infra-terraform", "workspace-package", "high"),
        edge("acme-web-app", "acme-infra-terraform", "ts-import", "medium"),
        edge("acme-web-app", "acme-utils", "workspace-package", "high"),
        edge("acme-web-app", "acme-utils", "ts-import", "medium"),
      ],
      transitive: false,
      limit: null,
      truncated: false,
    });

    const reverseDeps = expectOk<{
      component_id: string;
      edges: ControlPlaneDependencyEdge[];
      transitive: boolean;
      limit: number | null;
      truncated: boolean;
    }>(
      await runJson<{
        component_id: string;
        edges: ControlPlaneDependencyEdge[];
        transitive: boolean;
        limit: number | null;
        truncated: boolean;
      }>(["rdeps", "acme-infra-terraform"]),
    );

    expect(reverseDeps).toEqual({
      component_id: "acme-infra-terraform",
      edges: [
        edge("acme-utils", "acme-infra-terraform", "workspace-package", "high"),
        edge("acme-utils", "acme-infra-terraform", "ts-import", "medium"),
        edge("acme-web-app", "acme-infra-terraform", "workspace-package", "high"),
        edge("acme-web-app", "acme-infra-terraform", "ts-import", "medium"),
      ],
      transitive: false,
      limit: null,
      truncated: false,
    });

    const blast = expectOk<{
      changed_paths: string[];
      touched_components: string[];
      unmapped_paths: string[];
      impacted_components: string[];
      confidence: string;
      warnings: string[];
    }>(
      await runJson<{
        changed_paths: string[];
        touched_components: string[];
        unmapped_paths: string[];
        impacted_components: string[];
        confidence: string;
        warnings: string[];
      }>(["blast", "--changed", "packages/utils/src/index.ts"]),
    );

    expect(blast).toEqual({
      changed_paths: ["packages/utils/src/index.ts"],
      touched_components: ["acme-utils"],
      unmapped_paths: [],
      impacted_components: ["acme-utils", "acme-web-app"],
      confidence: "medium",
      warnings: ["Medium-confidence dependency edges included in blast radius."],
    });
  });

  it("returns stable TypeScript symbol results", async () => {
    const repoDir = await createTempRepoFromFixture();
    await buildControlPlaneModel({ repoRoot: repoDir });

    const runJson = createControlPlaneRunner(repoDir);

    const findResult = expectOk<SymbolFindResult>(
      await runJson<SymbolFindResult>(["symbols", "find", "formatUserId"]),
    );

    expect(findResult.query).toBe("formatUserId");
    expect(findResult.total).toBe(1);
    expect(findResult.limit).toBe(50);
    expect(findResult.truncated).toBe(false);
    expect(findResult.matches).toHaveLength(1);

    const formatMatch = findResult.matches[0];
    expect(formatMatch.symbol_id).toMatch(
      /^ts:acme-utils\/formatUserId@packages\/utils\/src\/index\.ts:\d+$/,
    );
    expect(formatMatch).toMatchObject({
      name: "formatUserId",
      kind: "function",
      file: "packages/utils/src/index.ts",
      component_id: "acme-utils",
      range: {
        start: { line: 12, column: 17 },
        end: { line: 12, column: 29 },
        start_offset: expect.any(Number),
        end_offset: expect.any(Number),
      },
    });

    const defResult = expectOk<SymbolDefinitionResult>(
      await runJson<SymbolDefinitionResult>([
        "symbols",
        "def",
        formatMatch.symbol_id,
        "--context",
        "2",
      ]),
    );

    expect(defResult.symbol_id).toBe(formatMatch.symbol_id);
    expect(defResult.definition).toEqual(formatMatch);
    expect(defResult.snippet).toEqual({
      start_line: 10,
      lines: [
        'export const DEFAULT_STATUS = "active";',
        "",
        "export function formatUserId(userId: UserId): string {",
        "  return userId.trim().toLowerCase();",
        "}",
      ],
    });

    const refsResult = expectOk<SymbolReferencesResult>(
      await runJson<SymbolReferencesResult>(["symbols", "refs", formatMatch.symbol_id]),
    );

    expect(refsResult.symbol_id).toBe(formatMatch.symbol_id);
    expect(refsResult.definition).toEqual(formatMatch);
    expect(refsResult.total).toBe(3);
    expect(refsResult.limit).toBe(50);
    expect(refsResult.truncated).toBe(false);
    expect(refsResult.group_by).toBeNull();
    expect(refsResult.groups).toBeNull();
    expect(refsResult.references).toHaveLength(3);
    expect(refsResult.references.map((ref) => ref.file)).toEqual([
      "apps/web/src/index.ts",
      "apps/web/src/index.ts",
      "packages/utils/src/index.ts",
    ]);
    expect(refsResult.references.map((ref) => ref.component_id)).toEqual([
      "acme-web-app",
      "acme-web-app",
      "acme-utils",
    ]);
    expect(refsResult.references.map((ref) => ref.range.start.line)).toEqual([2, 8, 20]);
    expect(refsResult.references.every((ref) => ref.is_definition === false)).toBe(true);
  });
});
