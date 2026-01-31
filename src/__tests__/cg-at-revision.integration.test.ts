import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";

import { createTempGitRepo } from "./helpers/temp-git-repo.js";

type TempRepoHandle = Awaited<ReturnType<typeof createTempGitRepo>>;

type JsonEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code?: string; message?: string } };

type SymbolFindResult = {
  matches?: Array<{ name?: string; file?: string }>;
};

type OwnershipResult = {
  owner?: { component?: { id?: string } } | null;
};

type DependencyQueryResult = {
  edges?: Array<{ from_component?: string; to_component?: string; kind?: string }>;
};

type TimeTravelRepo = {
  repoDir: string;
  commitA: string;
  commitB: string;
  commitC: string;
};

const CG_AT_TEST_TIMEOUT_MS = 30000;

let repoHandle: TempRepoHandle | null = null;

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

function parseLastJsonLine<T>(logSpy: ReturnType<typeof vi.spyOn>): T {
  const line = logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).pop() ?? "";
  return JSON.parse(line) as T;
}

function createJsonRunner(repoDir: string): <T>(args: string[]) => Promise<JsonEnvelope<T>> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  return async function runJson<T>(args: string[]): Promise<JsonEnvelope<T>> {
    logSpy.mockClear();
    await runCli(["node", "mycelium", "cg", ...args, "--json", "--repo", repoDir]);
    return parseLastJsonLine<JsonEnvelope<T>>(logSpy);
  };
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
    name: "cg-at-revision",
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

async function expectNoWorktreeLeaks(handle: TempRepoHandle): Promise<void> {
  const worktreeList = await handle.git(["worktree", "list"]);
  expect(worktreeList).not.toContain("mycelium-cg-worktree-");
}

// =============================================================================
// TESTS
// =============================================================================

describe("cg --at revision queries", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    if (!repoHandle) {
      return;
    }

    await repoHandle.cleanup();
    repoHandle = null;
  });

  it(
    "queries symbols, owner, and deps at specific revisions",
    async () => {
      const { repoDir, commitA, commitB, commitC } = await setupTimeTravelRepo();
      const runJson = createJsonRunner(repoDir);

      const fooAtA = expectOk(
        await runJson<SymbolFindResult>(["symbols", "find", "foo", "--at", commitA]),
      );
      const fooAtAMatches = fooAtA.matches ?? [];
      expect(fooAtAMatches.map((match) => match.name)).toContain("foo");
      expect(fooAtAMatches.map((match) => match.file)).toContain("a/index.ts");

      const fooAtC = expectOk(
        await runJson<SymbolFindResult>(["symbols", "find", "foo", "--at", commitC]),
      );
      expect(fooAtC.matches ?? []).toHaveLength(0);

      const barAtC = expectOk(
        await runJson<SymbolFindResult>(["symbols", "find", "bar", "--at", commitC]),
      );
      const barAtCMatches = barAtC.matches ?? [];
      expect(barAtCMatches.map((match) => match.name)).toContain("bar");
      expect(barAtCMatches.map((match) => match.file)).toContain("b/index.ts");

      const ownerAtA = expectOk(
        await runJson<OwnershipResult>(["owner", "a/index.ts", "--at", commitA]),
      );
      expect(ownerAtA.owner?.component?.id).toBe("a");

      const ownerAtC = expectOk(
        await runJson<OwnershipResult>(["owner", "b/index.ts", "--at", commitC]),
      );
      expect(ownerAtC.owner?.component?.id).toBe("b");

      const depsAtA = expectOk(
        await runJson<DependencyQueryResult>(["deps", "b", "--at", commitA]),
      );
      const depsAtB = expectOk(
        await runJson<DependencyQueryResult>(["deps", "b", "--at", commitB]),
      );

      expect(depsAtA.edges ?? []).toHaveLength(0);
      expect(depsAtB.edges ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from_component: "b", to_component: "a" }),
        ]),
      );

      if (!repoHandle) {
        throw new Error("Expected temp repo handle to be available.");
      }

      await expectNoWorktreeLeaks(repoHandle);
    },
    CG_AT_TEST_TIMEOUT_MS,
  );
});
