import { afterEach, describe, expect, it } from "vitest";

import { withControlPlaneModel } from "../control-plane/query/at-revision.js";

import { createTempGitRepo } from "./helpers/temp-git-repo.js";

type TempRepoHandle = Awaited<ReturnType<typeof createTempGitRepo>>;

type TimeTravelRepo = {
  repoDir: string;
  commitA: string;
  commitB: string;
};

const MODEL_AT_REVISION_TIMEOUT_MS = 20000;

let repoHandle: TempRepoHandle | null = null;

afterEach(async () => {
  if (!repoHandle) {
    return;
  }

  await repoHandle.cleanup();
  repoHandle = null;
});

// =============================================================================
// REPO FIXTURES
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
    name: "cg-model-at-revision",
    private: true,
    workspaces: ["app"],
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
    include: ["app/**/*.ts"],
  });
}

async function writeWorkspacePackage(handle: TempRepoHandle, root: string): Promise<void> {
  await writeJsonFile(handle, `${root}/package.json`, {
    name: root,
    private: true,
  });
}

async function setupTimeTravelRepo(): Promise<TimeTravelRepo> {
  repoHandle = await createTempGitRepo();

  await writeRootConfigs(repoHandle);
  await writeWorkspacePackage(repoHandle, "app");
  await repoHandle.writeFile(
    "app/index.ts",
    ["export function foo(): string {", '  return "foo";', "}", ""].join("\n"),
  );
  const commitA = await repoHandle.commit("commit A");

  await repoHandle.writeFile(
    "app/index.ts",
    ["export function bar(): string {", '  return "bar";', "}", ""].join("\n"),
  );
  const commitB = await repoHandle.commit("commit B");

  return { repoDir: repoHandle.repoDir, commitA, commitB };
}

async function expectNoWorktreeLeaks(handle: TempRepoHandle): Promise<void> {
  const worktreeList = await handle.git(["worktree", "list"]);
  expect(worktreeList).not.toContain("mycelium-cg-worktree-");
}

// =============================================================================
// TESTS
// =============================================================================

describe("control plane model at revision", () => {
  it(
    "returns different results across commits and cleans up worktrees",
    async () => {
      const { repoDir, commitA, commitB } = await setupTimeTravelRepo();

      const symbolsAtA = await withControlPlaneModel(
        { kind: "git-rev", repoRoot: repoDir, rev: commitA },
        async (model) => model.symbols_ts.definitions.map((definition) => definition.name),
      );

      const symbolsAtB = await withControlPlaneModel(
        { kind: "git-rev", repoRoot: repoDir, rev: commitB },
        async (model) => model.symbols_ts.definitions.map((definition) => definition.name),
      );

      expect(symbolsAtA).toContain("foo");
      expect(symbolsAtA).not.toContain("bar");
      expect(symbolsAtB).toContain("bar");
      expect(symbolsAtB).not.toContain("foo");

      if (!repoHandle) {
        throw new Error("Expected temp repo handle to be available.");
      }

      await expectNoWorktreeLeaks(repoHandle);
    },
    MODEL_AT_REVISION_TIMEOUT_MS,
  );
});
