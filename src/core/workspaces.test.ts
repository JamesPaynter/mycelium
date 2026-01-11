import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { taskWorkspaceDir } from "./paths.js";
import { prepareTaskWorkspace, removeRunWorkspace } from "./workspaces.js";

describe("prepareTaskWorkspace", () => {
  const projectName = "demo-project";
  const runId = "run-123";
  const taskId = "001";
  const mainBranch = "main";
  const taskBranch = "agent/001-sample";

  let tmpDir: string;
  let bareRepo: string;

  beforeEach(async () => {
    await removeRunWorkspace(projectName, runId);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-manager-"));
    bareRepo = path.join(tmpDir, "source.git");

    await execa("git", ["init", "--bare", bareRepo]);

    const working = path.join(tmpDir, "working");
    await execa("git", ["clone", bareRepo, working]);
    await execa("git", ["config", "user.email", "workspace@example.com"], { cwd: working });
    await execa("git", ["config", "user.name", "Workspace Tester"], { cwd: working });
    await execa("git", ["checkout", "-b", mainBranch], { cwd: working });
    await fse.writeFile(path.join(working, "README.md"), "# Demo\n");
    await execa("git", ["add", "README.md"], { cwd: working });
    await execa("git", ["commit", "-m", "init"], { cwd: working });
    await execa("git", ["push", "origin", mainBranch], { cwd: working });
    await execa("git", ["symbolic-ref", "HEAD", `refs/heads/${mainBranch}`], { cwd: bareRepo });
  });

  afterEach(async () => {
    await removeRunWorkspace(projectName, runId);
    await fse.remove(tmpDir);
  });

  it("clones repo and creates the task branch", async () => {
    const result = await prepareTaskWorkspace({
      projectName,
      runId,
      taskId,
      repoPath: bareRepo,
      mainBranch,
      taskBranch,
    });

    expect(result.created).toBe(true);

    const workspacePath = taskWorkspaceDir(projectName, runId, taskId);
    expect(result.workspacePath).toBe(workspacePath);
    expect(await fse.pathExists(workspacePath)).toBe(true);

    const branch = (
      await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath })
    ).stdout.trim();
    expect(branch).toBe(taskBranch);
  });

  it("reuses an existing clean workspace", async () => {
    const options = {
      projectName,
      runId,
      taskId,
      repoPath: bareRepo,
      mainBranch,
      taskBranch,
    };

    await prepareTaskWorkspace(options);

    const workspacePath = taskWorkspaceDir(projectName, runId, taskId);
    const markerPath = path.join(workspacePath, "marker.txt");
    await fse.writeFile(markerPath, "keep");

    const second = await prepareTaskWorkspace(options);

    expect(second.created).toBe(false);
    const branch = (
      await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath })
    ).stdout.trim();
    expect(branch).toBe(taskBranch);
    expect(await fse.readFile(markerPath, "utf8")).toBe("keep");
  });

  it("fails when workspace points to a different repo", async () => {
    const options = {
      projectName,
      runId,
      taskId,
      repoPath: bareRepo,
      mainBranch,
      taskBranch,
    };

    await prepareTaskWorkspace(options);

    const workspacePath = taskWorkspaceDir(projectName, runId, taskId);
    const otherRepo = path.join(tmpDir, "other.git");
    await execa("git", ["init", "--bare", otherRepo]);
    await execa("git", ["remote", "set-url", "origin", otherRepo], { cwd: workspacePath });

    await expect(prepareTaskWorkspace(options)).rejects.toThrow(/points to/i);
  });
});
