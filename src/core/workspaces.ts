import path from "node:path";

import fse from "fs-extra";

import { cloneRepo, checkoutBranchInClone, createBranchInClone } from "../git/branches.js";
import { branchExists, ensureCleanWorkingTree, getRemoteUrl } from "../git/git.js";

import { TaskError } from "./errors.js";
import { runWorkspaceDir, taskWorkspaceDir } from "./paths.js";
import { ensureDir, isGitRepo, pathExists } from "./utils.js";

export type PrepareTaskWorkspaceOptions = {
  projectName: string;
  runId: string;
  taskId: string;
  repoPath: string;
  mainBranch: string;
  taskBranch: string;
};

export type PrepareTaskWorkspaceResult = {
  workspacePath: string;
  created: boolean;
};

export async function prepareTaskWorkspace(
  opts: PrepareTaskWorkspaceOptions,
): Promise<PrepareTaskWorkspaceResult> {
  const workspacePath = taskWorkspaceDir(opts.projectName, opts.runId, opts.taskId);
  const exists = await pathExists(workspacePath);

  if (exists) {
    await assertExistingWorkspaceValid(workspacePath, opts.repoPath, opts.mainBranch);
    await ensureTaskBranchPresent(workspacePath, opts.mainBranch, opts.taskBranch);
    return { workspacePath, created: false };
  }

  await ensureDir(runWorkspaceDir(opts.projectName, opts.runId));
  await cloneRepo({ sourceRepo: opts.repoPath, destDir: workspacePath });
  await checkoutBranchInClone(workspacePath, opts.mainBranch);
  await createBranchInClone(workspacePath, opts.taskBranch, opts.mainBranch);

  return { workspacePath, created: true };
}

export async function removeTaskWorkspace(
  projectName: string,
  runId: string,
  taskId: string,
): Promise<void> {
  const dir = taskWorkspaceDir(projectName, runId, taskId);
  if (await pathExists(dir)) {
    await fse.remove(dir);
  }
}

export async function removeRunWorkspace(projectName: string, runId: string): Promise<void> {
  const dir = runWorkspaceDir(projectName, runId);
  if (await pathExists(dir)) {
    await fse.remove(dir);
  }
}

async function assertExistingWorkspaceValid(
  workspacePath: string,
  repoPath: string,
  mainBranch: string,
): Promise<void> {
  if (!isGitRepo(workspacePath)) {
    throw new TaskError(
      `Workspace exists but is not a git repository: ${workspacePath}. Remove it or choose a new run id.`,
    );
  }

  await ensureCleanWorkingTree(workspacePath);

  const originUrl = await getRemoteUrl(workspacePath);
  const [expectedLocal, originLocal] = await Promise.all([
    normalizeLocalPath(repoPath),
    normalizeLocalPath(originUrl),
  ]);

  if (expectedLocal && originLocal && expectedLocal !== originLocal) {
    throw new TaskError(
      `Workspace ${workspacePath} points to ${originUrl ?? "<unknown>"} (expected ${repoPath}). Remove it or use a different run id.`,
    );
  }

  const hasMainBranch = await branchExists(workspacePath, mainBranch);
  if (!hasMainBranch) {
    throw new TaskError(
      `Workspace ${workspacePath} is missing branch ${mainBranch}. Remove it and retry.`,
    );
  }
}

async function ensureTaskBranchPresent(
  workspacePath: string,
  mainBranch: string,
  taskBranch: string,
): Promise<void> {
  const hasTaskBranch = await branchExists(workspacePath, taskBranch);
  if (hasTaskBranch) {
    await checkoutBranchInClone(workspacePath, taskBranch);
    return;
  }

  await checkoutBranchInClone(workspacePath, mainBranch);
  await createBranchInClone(workspacePath, taskBranch, mainBranch);
}

async function normalizeLocalPath(input: string | null): Promise<string | null> {
  if (!input) return null;

  const urlLike = input.startsWith("file://") ? new URL(input) : null;
  const candidate = urlLike ? urlLike.pathname : input;

  if (
    candidate.startsWith("/") ||
    candidate.startsWith(".") ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.startsWith("~")
  ) {
    const resolved = path.resolve(candidate.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    try {
      return await fse.realpath(resolved);
    } catch {
      return resolved;
    }
  }

  return null;
}
