import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTaskBranchName } from "./branches.js";
import { headSha } from "./git.js";
import { fastForward, mergeTaskBranchesToTemp } from "./merge.js";

describe("mergeTaskBranchesToTemp + fastForward (integration)", () => {
  const mainBranch = "main";
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-merge-temp-"));
    repoPath = path.join(tmpDir, "integration");
    await initIntegrationRepo(repoPath, mainBranch);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it("keeps main unchanged when only temp merge is performed", async () => {
    const workspace = path.join(tmpDir, "workspace-a");
    const branch = buildTaskBranchName("agent/", "001", "Add greeting");

    await cloneWorkspace(repoPath, workspace);
    await checkoutTaskBranch(workspace, mainBranch, branch);
    await appendToFile(workspace, "notes-a.txt", "hello from A\n");

    const baseSha = await headSha(repoPath);
    const mergeResult = await mergeTaskBranchesToTemp({
      repoPath,
      mainBranch,
      tempBranch: "mycelium/merge/run-a/1",
      branches: [{ taskId: "001", branchName: branch, workspacePath: workspace }],
    });

    const mainHead = await revParse(repoPath, mainBranch);
    const tempHead = await revParse(repoPath, mergeResult.tempBranch);

    expect(mainHead).toBe(baseSha);
    expect(tempHead).toBe(mergeResult.mergeCommit);
  });

  it("fast-forwards main to the temp merge commit when requested", async () => {
    const workspace = path.join(tmpDir, "workspace-b");
    const branch = buildTaskBranchName("agent/", "002", "Record farewell");

    await cloneWorkspace(repoPath, workspace);
    await checkoutTaskBranch(workspace, mainBranch, branch);
    await appendToFile(workspace, "notes-b.txt", "goodbye from B\n");

    const baseSha = await headSha(repoPath);
    const mergeResult = await mergeTaskBranchesToTemp({
      repoPath,
      mainBranch,
      tempBranch: "mycelium/merge/run-b/1",
      branches: [{ taskId: "002", branchName: branch, workspacePath: workspace }],
    });

    const ffResult = await fastForward({
      repoPath,
      mainBranch,
      targetRef: mergeResult.tempBranch,
      expectedBaseSha: baseSha,
      cleanupBranch: mergeResult.tempBranch,
    });

    expect(ffResult.status).toBe("fast_forwarded");
    const mainHead = await revParse(repoPath, mainBranch);
    expect(mainHead).toBe(mergeResult.mergeCommit);
  });
});

async function initIntegrationRepo(repoPath: string, mainBranch: string): Promise<void> {
  await fse.ensureDir(repoPath);
  await execa("git", ["init"], { cwd: repoPath });
  await configureGitIdentity(repoPath);
  await fse.writeFile(path.join(repoPath, "README.md"), "# Demo\n", "utf8");
  await fse.writeFile(path.join(repoPath, "notes.txt"), "seed\n", "utf8");
  await fse.writeFile(path.join(repoPath, "config.txt"), "color=red\n", "utf8");
  await execa("git", ["add", "README.md", "notes.txt", "config.txt"], { cwd: repoPath });
  await execa("git", ["commit", "-m", "init"], { cwd: repoPath });
  await execa("git", ["branch", "-M", mainBranch], { cwd: repoPath });
}

async function cloneWorkspace(sourceRepo: string, dest: string): Promise<void> {
  await execa("git", ["clone", sourceRepo, dest]);
  await configureGitIdentity(dest);
}

async function checkoutTaskBranch(workspace: string, mainBranch: string, branch: string) {
  await execa("git", ["checkout", mainBranch], { cwd: workspace });
  await execa("git", ["checkout", "-b", branch, mainBranch], { cwd: workspace });
}

async function appendToFile(workspace: string, fileName: string, content: string): Promise<void> {
  await fse.appendFile(path.join(workspace, fileName), content, "utf8");
  await commitAll(workspace, `Update ${fileName}`);
}

async function commitAll(workspace: string, message: string): Promise<void> {
  await execa("git", ["add", "-A"], { cwd: workspace });
  await execa("git", ["commit", "-m", message], { cwd: workspace });
}

async function configureGitIdentity(cwd: string): Promise<void> {
  await execa("git", ["config", "user.email", "tester@example.com"], { cwd });
  await execa("git", ["config", "user.name", "Test Runner"], { cwd });
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const res = await execa("git", ["rev-parse", ref], { cwd });
  return res.stdout.trim();
}
