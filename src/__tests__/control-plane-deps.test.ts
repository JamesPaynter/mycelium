import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { extractComponents } from "../control-plane/extract/components.js";
import { extractTypeScriptImportDependencyEdges } from "../control-plane/extract/deps-ts-imports.js";
import { extractWorkspacePackageDependencyEdges } from "../control-plane/extract/deps-packages.js";
import {
  buildControlPlaneDependencies,
  resolveComponentDependencies,
  resolveComponentReverseDependencies,
} from "../control-plane/model/deps.js";
import type { ControlPlaneDependencyEdge } from "../control-plane/model/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const tempDirs: string[] = [];

// =============================================================================
// HELPERS
// =============================================================================

async function createDependencyRepo(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-deps-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);

  await writeJson(path.join(repoDir, "apps/web/package.json"), {
    name: "@acme/web-app",
    private: true,
    dependencies: {
      "@acme/utils": "workspace:*",
      react: "^18.0.0",
    },
    devDependencies: {
      "@acme/infra-terraform": "workspace:*",
    },
  });

  await writeJson(path.join(repoDir, "packages/utils/package.json"), {
    name: "@acme/utils",
    private: true,
    peerDependencies: {
      "@acme/infra-terraform": "workspace:*",
    },
  });

  await writeJson(path.join(repoDir, "infra/terraform/package.json"), {
    name: "@acme/infra-terraform",
    private: true,
  });

  await fse.ensureDir(path.join(repoDir, "apps/web/src"));
  await fs.writeFile(
    path.join(repoDir, "apps/web/src/index.ts"),
    [
      'import { helper } from "@acme/utils";',
      'import "@acme/infra-terraform";',
      'import "./local";',
      "",
      "export const ready = true;",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(repoDir, "apps/web/src/local.ts"),
    "export const local = true;\n",
    "utf8",
  );

  await fse.ensureDir(path.join(repoDir, "packages/utils/src"));
  await fs.writeFile(
    path.join(repoDir, "packages/utils/src/index.ts"),
    ['export * from "./internal";', 'import "@acme/infra-terraform";', ""].join("\n"),
    "utf8",
  );

  return repoDir;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function edge(
  from_component: string,
  to_component: string,
  kind: ControlPlaneDependencyEdge["kind"],
  confidence: ControlPlaneDependencyEdge["confidence"],
): ControlPlaneDependencyEdge {
  return { from_component, to_component, kind, confidence };
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane dependency extraction", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("extracts workspace package dependency edges", async () => {
    const repoRoot = await createDependencyRepo();
    const { components } = await extractComponents(repoRoot);

    const edges = await extractWorkspacePackageDependencyEdges({ repoRoot, components });

    expect(edges).toHaveLength(3);
    expect(edges).toEqual(
      expect.arrayContaining([
        edge("acme-web-app", "acme-utils", "workspace-package", "high"),
        edge("acme-web-app", "acme-infra-terraform", "workspace-package", "high"),
        edge("acme-utils", "acme-infra-terraform", "workspace-package", "high"),
      ]),
    );
  });

  it("extracts TypeScript import dependency edges", async () => {
    const repoRoot = await createDependencyRepo();
    const { components } = await extractComponents(repoRoot);

    const edges = await extractTypeScriptImportDependencyEdges({ repoRoot, components });

    expect(edges).toHaveLength(3);
    expect(edges).toEqual(
      expect.arrayContaining([
        edge("acme-web-app", "acme-utils", "ts-import", "medium"),
        edge("acme-web-app", "acme-infra-terraform", "ts-import", "medium"),
        edge("acme-utils", "acme-infra-terraform", "ts-import", "medium"),
      ]),
    );
  });
});

describe("control-plane dependency queries", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("resolves deps and rdeps with limit and transitive support", async () => {
    const repoRoot = await createDependencyRepo();
    const { components } = await extractComponents(repoRoot);
    const deps = await buildControlPlaneDependencies({ repoRoot, components });

    const directDeps = resolveComponentDependencies({
      componentId: "acme-web-app",
      edges: deps.edges,
    });

    expect(directDeps.transitive).toBe(false);
    expect(directDeps.limit).toBeNull();
    expect(directDeps.truncated).toBe(false);
    expect(directDeps.edges).toEqual(
      expect.arrayContaining([
        edge("acme-web-app", "acme-utils", "workspace-package", "high"),
        edge("acme-web-app", "acme-infra-terraform", "workspace-package", "high"),
        edge("acme-web-app", "acme-utils", "ts-import", "medium"),
        edge("acme-web-app", "acme-infra-terraform", "ts-import", "medium"),
      ]),
    );

    const limitedDeps = resolveComponentDependencies({
      componentId: "acme-web-app",
      edges: deps.edges,
      limit: 1,
    });

    expect(limitedDeps.edges).toHaveLength(1);
    expect(limitedDeps.truncated).toBe(true);

    const reverseDeps = resolveComponentReverseDependencies({
      componentId: "acme-infra-terraform",
      edges: deps.edges,
      transitive: true,
    });

    expect(reverseDeps.transitive).toBe(true);
    expect(reverseDeps.edges).toEqual(
      expect.arrayContaining([
        edge("acme-web-app", "acme-utils", "workspace-package", "high"),
        edge("acme-utils", "acme-infra-terraform", "ts-import", "medium"),
      ]),
    );
  });
});
