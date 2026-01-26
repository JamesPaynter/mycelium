import {
  addRemote,
  abortMerge,
  checkout,
  ensureCleanWorkingTree,
  fetchRemote,
  headSha,
  isMergeConflictError,
  mergeNoFf,
  removeRemote,
} from "./git.js";

export type TaskBranchToMerge = {
  taskId: string;
  branchName: string;
  workspacePath: string;
};

export type MergeConflict = {
  branch: TaskBranchToMerge;
  message: string;
};

export type MergeResult = {
  status: "merged";
  merged: TaskBranchToMerge[];
  conflicts: MergeConflict[];
  mergeCommit: string;
};

export async function mergeTaskBranches(opts: {
  repoPath: string;
  mainBranch: string;
  branches: TaskBranchToMerge[];
}): Promise<MergeResult> {
  const { repoPath, mainBranch, branches } = opts;

  await ensureCleanWorkingTree(repoPath);
  await checkout(repoPath, mainBranch);

  const merged: TaskBranchToMerge[] = [];
  const conflicts: MergeConflict[] = [];
  let mergeCommit = await headSha(repoPath);

  for (const branch of branches) {
    const remoteName = buildWorkspaceRemoteName(branch.taskId);
    await removeRemote(repoPath, remoteName).catch(() => undefined);

    try {
      await addRemote(repoPath, remoteName, branch.workspacePath);
      await fetchRemote(repoPath, remoteName, branch.branchName);
      await mergeNoFf(repoPath, "FETCH_HEAD", `Merge ${branch.branchName}`);

      mergeCommit = await headSha(repoPath);
      merged.push(branch);
    } catch (err) {
      if (isMergeConflictError(err)) {
        await abortMerge(repoPath).catch(() => undefined);

        conflicts.push({
          branch,
          message: formatMergeError(err),
        });
        continue;
      }

      throw err;
    } finally {
      await removeRemote(repoPath, remoteName).catch(() => undefined);
    }
  }

  return { status: "merged", merged, conflicts, mergeCommit };
}

function buildWorkspaceRemoteName(taskId: string): string {
  const safeId = taskId.replace(/[^A-Za-z0-9_.-]/g, "-") || "task";
  return `task-${safeId}`;
}

function formatMergeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
