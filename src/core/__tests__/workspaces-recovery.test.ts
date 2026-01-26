import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPathsContext, taskWorkspaceDir, type PathsContext } from "../paths.js";
import { prepareTaskWorkspace, removeRunWorkspace } from "../workspaces.js";

// =============================================================================
// TESTS
// =============================================================================

describe("prepareTaskWorkspace recovery", () => {
  const projectName = "demo-project";
  const runId = "run-456";
  const taskId = "002";
  const mainBranch = "main";
  const taskBranch = "agent/002-recovery";

  let tmpDir: string;
  let bareRepo: string;
  let paths: PathsContext;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-recovery-"));
    paths = createPathsContext({ myceliumHome: path.join(tmpDir, ".mycelium-home") });
    await removeRunWorkspace(projectName, runId, paths);
    bareRepo = path.join(tmpDir, "source.git");

    await execa("git", ["init", "--bare", bareRepo]);

    const working = path.join(tmpDir, "working");
    await execa("git", ["clone", bareRepo, working]);
    await execa("git", ["config", "user.email", "workspace@example.com"], { cwd: working });
    await execa("git", ["config", "user.name", "Workspace Tester"], { cwd: working });
    await execa("git", ["checkout", "-b", mainBranch], { cwd: working });
    await fse.writeFile(path.join(working, "README.md"), "# Demo\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: working });
    await execa("git", ["commit", "-m", "init"], { cwd: working });
    await execa("git", ["push", "origin", mainBranch], { cwd: working });
    await execa("git", ["symbolic-ref", "HEAD", `refs/heads/${mainBranch}`], { cwd: bareRepo });
  });

  afterEach(async () => {
    await removeRunWorkspace(projectName, runId, paths);
    await fse.remove(tmpDir);
  });

  it("cleans dirty workspaces when recovery is enabled", async () => {
    const options = {
      projectName,
      runId,
      taskId,
      repoPath: bareRepo,
      mainBranch,
      taskBranch,
      paths,
      recoverDirtyWorkspace: true,
    };

    await prepareTaskWorkspace(options);

    const workspacePath = taskWorkspaceDir(projectName, runId, taskId, paths);
    const readmePath = path.join(workspacePath, "README.md");
    await fse.writeFile(readmePath, "# Demo\nDirty\n", "utf8");

    const result = await prepareTaskWorkspace(options);
    const status = await execa("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: workspacePath,
    });

    expect(result.created).toBe(false);
    expect(result.recovered).toBe(true);
    expect(status.stdout.trim()).toBe("");
    expect(await fse.readFile(readmePath, "utf8")).toBe("# Demo\n");
  });
});
