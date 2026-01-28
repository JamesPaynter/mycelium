import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

import { cloneRepo } from "./branches.js";

describe("cloneRepo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-branches-"));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it("wraps git clone failures with UserFacingError", async () => {
    const missingRepo = path.join(tmpDir, "missing-repo");
    const destDir = path.join(tmpDir, "clone-target");

    try {
      await cloneRepo({ sourceRepo: missingRepo, destDir });
      throw new Error("Expected cloneRepo to throw.");
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const error = err as UserFacingError;
      expect(error.code).toBe(USER_FACING_ERROR_CODES.git);
      expect(error.title).toBe("Git clone failed.");
      expect(error.cause).toBeInstanceOf(GitError);
    }
  });
});
