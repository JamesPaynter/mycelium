import { UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

import {
  addRemote,
  abortMerge,
  branchExists,
  checkout,
  checkoutNewBranch,
  deleteLocalBranch,
  ensureCleanWorkingTree,
  fetchRemote,
  git,
  headSha,
  isAncestor,
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

export type TempMergeResult = MergeResult & {
  baseSha: string;
  tempBranch: string;
};

export type FastForwardResult =
  | {
      status: "fast_forwarded";
      previousHead: string;
      head: string;
    }
  | {
      status: "blocked";
      reason: "main_advanced" | "non_fast_forward";
      message: string;
      currentHead: string;
      targetRef: string;
    };

export async function mergeTaskBranches(opts: {
  repoPath: string;
  mainBranch: string;
  branches: TaskBranchToMerge[];
}): Promise<MergeResult> {
  const { repoPath, mainBranch, branches } = opts;

  await ensureCleanWorkingTree(repoPath);
  await checkoutBranchOrThrow(repoPath, mainBranch);

  return mergeTaskBranchesInCurrent(repoPath, branches);
}

export async function mergeTaskBranchesToTemp(opts: {
  repoPath: string;
  mainBranch: string;
  tempBranch: string;
  branches: TaskBranchToMerge[];
}): Promise<TempMergeResult> {
  const { repoPath, mainBranch, tempBranch, branches } = opts;

  await ensureCleanWorkingTree(repoPath);
  await checkoutBranchOrThrow(repoPath, mainBranch);
  const baseSha = await headSha(repoPath);
  const resolvedTempBranch = await resolveTempBranchName(repoPath, tempBranch);

  await checkoutNewBranchOrThrow(repoPath, resolvedTempBranch, baseSha);

  const mergeResult = await mergeTaskBranchesInCurrent(repoPath, branches);

  return {
    ...mergeResult,
    baseSha,
    tempBranch: resolvedTempBranch,
  };
}

export async function fastForward(opts: {
  repoPath: string;
  mainBranch: string;
  targetRef: string;
  expectedBaseSha?: string;
  cleanupBranch?: string;
}): Promise<FastForwardResult> {
  const { repoPath, mainBranch, targetRef, expectedBaseSha, cleanupBranch } = opts;

  await ensureCleanWorkingTree(repoPath);
  await checkoutBranchOrThrow(repoPath, mainBranch);

  const currentHead = await headSha(repoPath);
  if (expectedBaseSha && currentHead !== expectedBaseSha) {
    return {
      status: "blocked",
      reason: "main_advanced",
      message: `Expected ${mainBranch} at ${expectedBaseSha} but found ${currentHead}.`,
      currentHead,
      targetRef,
    };
  }

  const canFastForward = await isAncestor(repoPath, currentHead, targetRef);
  if (!canFastForward) {
    return {
      status: "blocked",
      reason: "non_fast_forward",
      message: `Cannot fast-forward ${mainBranch} to ${targetRef}.`,
      currentHead,
      targetRef,
    };
  }

  try {
    await git(repoPath, ["merge", "--ff-only", targetRef]);
  } catch (err) {
    throw createMergeUserFacingError(`Unable to fast-forward ${mainBranch} to ${targetRef}.`, err);
  }
  const nextHead = await headSha(repoPath);

  if (cleanupBranch) {
    await deleteLocalBranch(repoPath, cleanupBranch).catch(() => undefined);
  }

  return { status: "fast_forwarded", previousHead: currentHead, head: nextHead };
}

function buildWorkspaceRemoteName(taskId: string): string {
  const safeId = taskId.replace(/[^A-Za-z0-9_.-]/g, "-") || "task";
  return `task-${safeId}`;
}

async function mergeTaskBranchesInCurrent(
  repoPath: string,
  branches: TaskBranchToMerge[],
): Promise<MergeResult> {
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

        conflicts.push({ branch, message: formatMergeConflictMessage(branch) });
        continue;
      }

      throw createMergeUserFacingError(`Unable to merge ${branch.branchName}.`, err);
    } finally {
      await removeRemote(repoPath, remoteName).catch(() => undefined);
    }
  }

  return { status: "merged", merged, conflicts, mergeCommit };
}

async function resolveTempBranchName(repoPath: string, desiredName: string): Promise<string> {
  let candidate = desiredName;
  let counter = 1;

  while (await branchExists(repoPath, candidate)) {
    candidate = `${desiredName}-${counter}`;
    counter += 1;
  }

  return candidate;
}

// =============================================================================
// ERROR HELPERS
// =============================================================================

const MERGE_ERROR_HINT =
  "Run `git status` to inspect the repository. If a merge is in progress, run `git merge --abort` to clean up.";
const CHECKOUT_ERROR_HINT = "Make sure the branch exists locally and is up to date.";
const CREATE_BRANCH_ERROR_HINT = "Make sure the branch name and start point are valid.";

async function checkoutBranchOrThrow(repoPath: string, branch: string): Promise<void> {
  try {
    await checkout(repoPath, branch);
  } catch (err) {
    throw createCheckoutUserFacingError(branch, err);
  }
}

async function checkoutNewBranchOrThrow(
  repoPath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  try {
    await checkoutNewBranch(repoPath, branch, startPoint);
  } catch (err) {
    throw createBranchUserFacingError(branch, startPoint, err);
  }
}

function createMergeUserFacingError(message: string, err: unknown): UserFacingError {
  if (err instanceof UserFacingError) {
    return err;
  }

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.git,
    title: "Git merge failed.",
    message,
    hint: MERGE_ERROR_HINT,
    cause: err,
  });
}

function createCheckoutUserFacingError(branch: string, err: unknown): UserFacingError {
  if (err instanceof UserFacingError) {
    return err;
  }

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.git,
    title: "Git checkout failed.",
    message: `Unable to checkout ${branch}.`,
    hint: CHECKOUT_ERROR_HINT,
    cause: err,
  });
}

function createBranchUserFacingError(
  branch: string,
  startPoint: string,
  err: unknown,
): UserFacingError {
  if (err instanceof UserFacingError) {
    return err;
  }

  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.git,
    title: "Git branch creation failed.",
    message: `Unable to create ${branch} from ${startPoint}.`,
    hint: CREATE_BRANCH_ERROR_HINT,
    cause: err,
  });
}

function formatMergeConflictMessage(branch: TaskBranchToMerge): string {
  return `Merge conflict while merging ${branch.branchName}.`;
}
