import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";
import { buildControlPlaneModel } from "../control-plane/model/build.js";
import type {
  ControlPlaneComponent,
  ControlPlaneDependencyEdge,
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolReference,
} from "../control-plane/model/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const tempDirs: string[] = [];

const EXPECTED_COMPONENTS: ControlPlaneComponent[] = [
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
];



// =============================================================================
// HELPERS
// =============================================================================

type JsonEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string; details: unknown } };

type SymbolFindResult = {
  query: string;
  total: number;
  limit: number;
  truncated: boolean;
  matches: ControlPlaneSymbolDefinition[];
};

type SymbolDefinitionResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  snippet: { start_line: number; lines: string[] } | null;
};

type SymbolReferencesResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  total: number;
  limit: number;
  truncated: boolean;
  group_by: string | null;
  references: ControlPlaneSymbolReference[];
  groups: Array<{ key: string; references: ControlPlaneSymbolReference[] }> | null;
};

async function runCli(argv: string[]): Promise<void> {
  const program = buildCli();
  installExitOverride(program);
  await program.parseAsync(argv);
}

function installExitOverride(command: Command): void {
  command.exitOverride();

  for (const child of command.commands) {
    installExitOverride(child);
  }
}

async function createTempRepoFromFixture(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-acceptance-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  return repoDir;
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cp-acceptance@example.com"], {
    cwd: repoDir,
  });
  await execa("git", ["config", "user.name", "Control Plane Acceptance"], {
    cwd: repoDir,
  });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function createControlPlaneRunner(
  repoDir: string,
): (args: string[]) => Promise<JsonEnvelope<unknown>> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  return async (args: string[]) => {
    logSpy.mockClear();
    await runCli([
      "node",
      "mycelium",
      "cp",
      ...args,
      "--json",
      "--repo",
      repoDir,
      "--no-build",
    ]);

    return parseLastJsonLine<JsonEnvelope<unknown>>(logSpy);
  };
}

function parseLastJsonLine<T>(logSpy: ReturnType<typeof vi.spyOn>): T {
  const line =
    logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).pop() ?? "";
  return JSON.parse(line) as T;
}

function expectOk<T>(payload: JsonEnvelope<T>): T {
  expect(payload.ok).toBe(true);
  if (payload.ok) {
    return payload.result;
  }
  throw new Error(payload.error.message);
}

function expectedComponentById(componentId: string): ControlPlaneComponent {
  const match = EXPECTED_COMPONENTS.find(
    (component) => component.id === componentId,
  );
  if (!match) {
    throw new Error(`Missing expected component: ${componentId}`);
  }
  return match;
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

describe("control-plane acceptance", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns stable component and ownership results", async () => {
    const repoDir = await createTempRepoFromFixture();
    await buildControlPlaneModel({ repoRoot: repoDir });

    const runJson = createControlPlaneRunner(repoDir);

    const components = expectOk<ControlPlaneComponent[]>(
      await runJson(["components", "list"]),
    );
    expect(components).toEqual(EXPECTED_COMPONENTS);

    const webComponent = expectOk<ControlPlaneComponent | null>(
      await runJson(["components", "show", "acme-web-app"]),
    );
    expect(webComponent).toEqual(expectedComponentById("acme-web-app"));

    const owner = expectOk<{
      path: string;
      owner: { component: ControlPlaneComponent; root: string } | null;
      candidates: Array<{ component: ControlPlaneComponent; root: string }>;
    }>(await runJson(["owner", "apps/web/src/index.ts"]));

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
    }>(await runJson(["deps", "acme-web-app"]));

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
    }>(await runJson(["rdeps", "acme-infra-terraform"]));

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
    }>(await runJson(["blast", "--changed", "packages/utils/src/index.ts"]));

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
      await runJson(["symbols", "find", "formatUserId"]),
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
      await runJson([
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
      await runJson(["symbols", "refs", formatMatch.symbol_id]),
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
    expect(refsResult.references.map((ref) => ref.range.start.line)).toEqual([
      2,
      8,
      20,
    ]);
    expect(refsResult.references.every((ref) => ref.is_definition === false)).toBe(
      true,
    );
  });
});
