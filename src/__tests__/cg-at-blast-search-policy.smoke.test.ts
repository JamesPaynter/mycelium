import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";
import * as controlPlaneBuild from "../control-plane/model/build.js";

import { createTempGitRepo } from "./helpers/temp-git-repo.js";

type TempRepoHandle = Awaited<ReturnType<typeof createTempGitRepo>>;

type JsonEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code?: string; message?: string } };

type BlastResult = {
  touched_components?: string[];
};

type PolicyEvalResult = {
  base_sha?: string;
  changed_files?: string[];
};

type TimeTravelRepo = {
  repoDir: string;
  commitA: string;
  commitB: string;
  commitC: string;
};

const CG_AT_SMOKE_TIMEOUT_MS = 120000;

const snapshotCache = new Map<
  string,
  Awaited<ReturnType<typeof controlPlaneBuild.buildControlPlaneModelSnapshot>>
>();
const originalBuildSnapshot = controlPlaneBuild.buildControlPlaneModelSnapshot;

let repoHandle: TempRepoHandle | null = null;

// =============================================================================
// SNAPSHOT CACHE
// =============================================================================

function installSnapshotCache(): void {
  // Avoid rebuilding the same snapshot for every --at command in this test.
  vi.spyOn(controlPlaneBuild, "buildControlPlaneModelSnapshot").mockImplementation(
    async (options) => {
      const key = options.baseSha?.trim();
      if (key) {
        const cached = snapshotCache.get(key);
        if (cached) {
          return cached;
        }
      }

      const result = await originalBuildSnapshot(options);
      if (key) {
        snapshotCache.set(key, result);
      }

      return result;
    },
  );
}

// =============================================================================
// CLI HELPERS
// =============================================================================

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

function collectStdout(writeSpy: ReturnType<typeof vi.spyOn>): string {
  return writeSpy.mock.calls
    .map(([chunk]: [string | Uint8Array]) =>
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    )
    .join("");
}

function parseLastJsonLine<T>(logSpy: ReturnType<typeof vi.spyOn>): T {
  const line =
    logSpy.mock.calls
      .map((call: unknown[]) => call.map((value) => String(value)).join(" "))
      .pop() ?? "";
  return JSON.parse(line) as T;
}

function expectOk<T>(payload: JsonEnvelope<T>): T {
  expect(payload.ok).toBe(true);
  if (payload.ok) {
    return payload.result;
  }
  throw new Error(payload.error?.message ?? "Control graph command failed.");
}

// =============================================================================
// REPO FIXTURE BUILDERS
// =============================================================================

async function writeJsonFile(
  handle: TempRepoHandle,
  relPath: string,
  payload: unknown,
): Promise<void> {
  await handle.writeFile(relPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeRootConfigs(handle: TempRepoHandle): Promise<void> {
  await writeJsonFile(handle, "package.json", {
    name: "cg-at-blast-search-policy",
    private: true,
    workspaces: ["a", "b"],
  });

  await writeJsonFile(handle, "tsconfig.json", {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "NodeNext",
      strict: false,
      noEmit: true,
      noLib: true,
    },
    include: ["a/**/*.ts", "b/**/*.ts"],
  });
}

async function writeWorkspacePackage(
  handle: TempRepoHandle,
  root: string,
  options: { dependencies?: Record<string, string> } = {},
): Promise<void> {
  await writeJsonFile(handle, `${root}/package.json`, {
    name: root,
    private: true,
    ...options,
  });
}

async function setupTimeTravelRepo(): Promise<TimeTravelRepo> {
  repoHandle = await createTempGitRepo();

  await writeRootConfigs(repoHandle);
  await writeWorkspacePackage(repoHandle, "a");
  await writeWorkspacePackage(repoHandle, "b");
  await repoHandle.writeFile(
    "a/index.ts",
    ["export function foo(): string {", '  return "foo";', "}", ""].join("\n"),
  );
  const commitA = await repoHandle.commit("commit A");

  await writeWorkspacePackage(repoHandle, "b", { dependencies: { a: "workspace:*" } });
  await repoHandle.writeFile(
    "b/useFoo.ts",
    ['import { foo } from "../a/index";', "", "export const value = foo();", ""].join("\n"),
  );
  const commitB = await repoHandle.commit("commit B");

  await repoHandle.mv("a/index.ts", "b/index.ts");
  await repoHandle.writeFile(
    "b/index.ts",
    ["export function bar(): string {", '  return "bar";', "}", ""].join("\n"),
  );
  await repoHandle.writeFile(
    "b/useFoo.ts",
    ['import { bar } from "./index";', "", "export const value = bar();", ""].join("\n"),
  );
  const commitC = await repoHandle.commit("commit C");

  return { repoDir: repoHandle.repoDir, commitA, commitB, commitC };
}

// =============================================================================
// TESTS
// =============================================================================

describe("cg --at blast/search/policy smoke", () => {
  beforeEach(() => {
    snapshotCache.clear();
    installSnapshotCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    snapshotCache.clear();
    process.exitCode = 0;

    if (!repoHandle) {
      return;
    }

    await repoHandle.cleanup();
    repoHandle = null;
  });

  it(
    "searches snapshots with --at",
    async () => {
      const { repoDir, commitA, commitC } = await setupTimeTravelRepo();
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runCli(["node", "mycelium", "cg", "search", "foo", "--repo", repoDir, "--at", commitA]);

      const outputAtA = collectStdout(writeSpy);
      expect(outputAtA).toContain("a/index.ts");

      writeSpy.mockClear();
      process.exitCode = 0;

      await runCli(["node", "mycelium", "cg", "search", "foo", "--repo", repoDir, "--at", commitC]);

      const outputAtC = collectStdout(writeSpy);
      expect(outputAtC.trim()).toBe("");
    },
    CG_AT_SMOKE_TIMEOUT_MS,
  );

  it(
    "runs blast and policy eval with --at",
    async () => {
      const { repoDir, commitA } = await setupTimeTravelRepo();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await runCli([
        "node",
        "mycelium",
        "cg",
        "blast",
        "--changed",
        "a/index.ts",
        "--json",
        "--repo",
        repoDir,
        "--at",
        commitA,
      ]);

      const blastPayload = expectOk(parseLastJsonLine<JsonEnvelope<BlastResult>>(logSpy));
      expect(blastPayload.touched_components ?? []).toContain("a");

      logSpy.mockClear();
      process.exitCode = 0;

      await runCli([
        "node",
        "mycelium",
        "cg",
        "policy",
        "eval",
        "--changed",
        "a/index.ts",
        "--json",
        "--repo",
        repoDir,
        "--at",
        commitA,
      ]);

      const policyPayload = expectOk(parseLastJsonLine<JsonEnvelope<PolicyEvalResult>>(logSpy));
      expect(policyPayload.base_sha).toBe(commitA);
      expect(policyPayload.changed_files ?? []).toContain("a/index.ts");
    },
    CG_AT_SMOKE_TIMEOUT_MS,
  );
});
