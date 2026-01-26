/**
 * Git VCS adapter tests.
 * Purpose: ensure the adapter wires the git helpers and applies task branch prefixes.
 * Assumptions: helper functions are importable without side effects.
 * Usage: vitest run src/app/orchestrator/vcs/git-vcs.test.ts
 */

import { describe, expect, it } from "vitest";

import { listChangedFiles } from "../../../git/changes.js";
import {
  checkout,
  checkoutOrCreateBranch,
  ensureCleanWorkingTree,
  headSha,
  isAncestor,
  resolveRunBaseSha,
} from "../../../git/git.js";
import { mergeTaskBranches } from "../../../git/merge.js";

import { createGitVcs } from "./git-vcs.js";


// =============================================================================
// TESTS
// =============================================================================

describe("createGitVcs", () => {
  it("wires git helpers and applies the task branch prefix", () => {
    const vcs = createGitVcs({ taskBranchPrefix: "agent/" });

    expect(vcs.ensureCleanWorkingTree).toBe(ensureCleanWorkingTree);
    expect(vcs.checkout).toBe(checkout);
    expect(vcs.checkoutOrCreateBranch).toBe(checkoutOrCreateBranch);
    expect(vcs.resolveRunBaseSha).toBe(resolveRunBaseSha);
    expect(vcs.headSha).toBe(headSha);
    expect(vcs.isAncestor).toBe(isAncestor);
    expect(vcs.mergeTaskBranches).toBe(mergeTaskBranches);
    expect(vcs.listChangedFiles).toBe(listChangedFiles);
    expect(vcs.buildTaskBranchName("001", "Fix Login Button")).toBe(
      "agent/001-fix-login-button",
    );
  });
});
