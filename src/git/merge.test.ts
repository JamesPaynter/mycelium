import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTaskBranchName } from "./branches.js";
import { headSha } from "./git.js";
import { mergeTaskBranches } from "./merge.js";

describe("buildTaskBranchName", () => {
  it("formats prefix, task id, and kebab-cased task name", () => {
    expect(buildTaskBranchName("agent/", "001", "Fix Login Button")).toBe(
      "agent/001-fix-login-button",
    );
  });

  it("falls back when the task name is empty after slugification", () => {
    expect(buildTaskBranchName("agent/", "002", "!!!")).toBe("agent/002-task");
  });
});

describe("mergeTaskBranches", () => {
  const mainBranch = "main";
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-merge-"));
    repoPath = path.join(tmpDir, "integration");
    await initIntegrationRepo(repoPath, mainBranch);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it("merges task branches sequentially", async () => {
    const workspaceA = path.join(tmpDir, "workspace-a");
    const workspaceB = path.join(tmpDir, "workspace-b");

    const branchA = buildTaskBranchName("agent/", "001", "Add greeting");
    const branchB = buildTaskBranchName("agent/", "002", "Record farewell");

    await cloneWorkspace(repoPath, workspaceA);
    await checkoutTaskBranch(workspaceA, mainBranch, branchA);
    await appendToFile(workspaceA, "notes-a.txt", "hello from A\n");

    await cloneWorkspace(repoPath, workspaceB);
    await checkoutTaskBranch(workspaceB, mainBranch, branchB);
    await appendToFile(workspaceB, "notes-b.txt", "goodbye from B\n");

    const result = await mergeTaskBranches({
      repoPath,
      mainBranch,
      branches: [
        { taskId: "001", branchName: branchA, workspacePath: workspaceA },
        { taskId: "002", branchName: branchB, workspacePath: workspaceB },
      ],
    });

    expect(result.status).toBe("merged");
    expect(result.merged.map((b) => b.taskId)).toEqual(["001", "002"]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergeCommit).toBe(await headSha(repoPath));

    const fromA = await fse.readFile(path.join(repoPath, "notes-a.txt"), "utf8");
    const fromB = await fse.readFile(path.join(repoPath, "notes-b.txt"), "utf8");
    expect(fromA).toContain("hello from A");
    expect(fromB).toContain("goodbye from B");
  });

  it("continues merging after a conflict", async () => {
    const workspaceA = path.join(tmpDir, "workspace-a");
    const workspaceB = path.join(tmpDir, "workspace-b");
    const workspaceC = path.join(tmpDir, "workspace-c");

    const branchA = buildTaskBranchName("agent/", "010", "bump value");
    const branchB = buildTaskBranchName("agent/", "011", "conflicting value");
    const branchC = buildTaskBranchName("agent/", "012", "add notes");

    await cloneWorkspace(repoPath, workspaceA);
    await checkoutTaskBranch(workspaceA, mainBranch, branchA);
    await fse.writeFile(path.join(workspaceA, "config.txt"), "color=blue\n", "utf8");
    await commitAll(workspaceA, "Set color to blue");

    await cloneWorkspace(repoPath, workspaceB);
    await checkoutTaskBranch(workspaceB, mainBranch, branchB);
    await fse.writeFile(path.join(workspaceB, "config.txt"), "color=green\n", "utf8");
    await commitAll(workspaceB, "Set color to green");

    await cloneWorkspace(repoPath, workspaceC);
    await checkoutTaskBranch(workspaceC, mainBranch, branchC);
    await appendToFile(workspaceC, "notes-c.txt", "notes from C\n");

    const result = await mergeTaskBranches({
      repoPath,
      mainBranch,
      branches: [
        { taskId: "010", branchName: branchA, workspacePath: workspaceA },
        { taskId: "011", branchName: branchB, workspacePath: workspaceB },
        { taskId: "012", branchName: branchC, workspacePath: workspaceC },
      ],
    });

    expect(result.status).toBe("merged");
    expect(result.merged.map((b) => b.taskId)).toEqual(["010", "012"]);
    expect(result.conflicts.map((conflict) => conflict.branch.taskId)).toEqual(["011"]);
    expect(result.mergeCommit).toBe(await headSha(repoPath));

    const status = await gitStatus(repoPath);
    expect(status).toBe("");
    const contents = await fse.readFile(path.join(repoPath, "config.txt"), "utf8");
    expect(contents.trim()).toBe("color=blue");
    const fromC = await fse.readFile(path.join(repoPath, "notes-c.txt"), "utf8");
    expect(fromC).toContain("notes from C");
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

async function gitStatus(cwd: string): Promise<string> {
  const res = await execa("git", ["status", "--porcelain"], { cwd });
  return res.stdout.trim();
}
