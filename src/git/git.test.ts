import { describe, expect, it } from "vitest";

import { GitError } from "../core/errors.js";

import { isMergeConflictError } from "./git.js";

describe("isMergeConflictError", () => {
  it("detects conflict markers without the merge conflict phrase", () => {
    const err = new GitError("git merge failed", {
      stdout: "CONFLICT (rename/delete): src/app.ts deleted in HEAD and modified in feature\n",
      stderr: "",
    });

    expect(isMergeConflictError(err)).toBe(true);
  });

  it("ignores non-conflict git errors", () => {
    const err = new GitError("git merge failed", {
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    });

    expect(isMergeConflictError(err)).toBe(false);
  });
});
