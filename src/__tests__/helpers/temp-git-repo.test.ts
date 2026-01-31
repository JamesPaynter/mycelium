import { afterEach, describe, expect, it } from "vitest";

import { createTempGitRepo } from "./temp-git-repo.js";

type TempRepoHandle = Awaited<ReturnType<typeof createTempGitRepo>>;

let repoHandle: TempRepoHandle | null = null;

afterEach(async () => {
  if (!repoHandle) return;
  await repoHandle.cleanup();
  repoHandle = null;
});

// =============================================================================
// TESTS
// =============================================================================

describe("temp git repo helper", () => {
  it("creates commits and exposes git history", async () => {
    repoHandle = await createTempGitRepo();

    await repoHandle.writeFile("notes/first.txt", "first\n");
    const firstSha = await repoHandle.commit("first commit");

    await repoHandle.writeFile("notes/second.txt", "second\n");
    const secondSha = await repoHandle.commit("second commit");

    expect(firstSha).not.toEqual(secondSha);

    const log = await repoHandle.git(["log", "--oneline"]);

    expect(log).toContain("first commit");
    expect(log).toContain("second commit");
  });
});
