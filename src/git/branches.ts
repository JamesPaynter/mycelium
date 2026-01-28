import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";

import { GitError, UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";
import { ensureDir, slugify } from "../core/utils.js";

export function buildTaskBranchName(prefix: string, taskId: string, taskName: string): string {
  const slug = slugify(taskName);
  const safeSlug = slug.length > 0 ? slug : "task";
  return `${prefix}${taskId}-${safeSlug}`;
}

export async function cloneRepo(opts: {
  sourceRepo: string;
  destDir: string;
  branch?: string;
}): Promise<void> {
  await ensureDir(path.dirname(opts.destDir));
  // Remove existing directory if present (we always recreate).
  await fse.remove(opts.destDir);

  const args = ["clone", "--no-hardlinks", opts.sourceRepo, opts.destDir];
  if (opts.branch) {
    // NOTE: Cannot use --branch with local source reliably for detached? It's ok.
  }

  try {
    await execa("git", args, { stdio: "pipe" });
  } catch (err) {
    const gitError = buildGitErrorFromCommand(args, undefined, err);
    throw new UserFacingError({
      code: USER_FACING_ERROR_CODES.git,
      title: "Git clone failed.",
      message: `Unable to clone ${opts.sourceRepo}.`,
      hint: "Check that the repository path exists and is accessible.",
      cause: gitError,
    });
  }
}

export async function checkoutBranchInClone(cwd: string, branch: string): Promise<void> {
  const args = ["checkout", branch];
  try {
    await execa("git", args, { cwd, stdio: "pipe" });
  } catch (err) {
    const gitError = buildGitErrorFromCommand(args, cwd, err);
    throw new UserFacingError({
      code: USER_FACING_ERROR_CODES.git,
      title: "Git checkout failed.",
      message: `Unable to checkout ${branch}.`,
      hint: "Make sure the branch exists locally.",
      cause: gitError,
    });
  }
}

export async function createBranchInClone(
  cwd: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  const args = ["checkout", "-b", branch, startPoint];
  try {
    await execa("git", args, { cwd, stdio: "pipe" });
  } catch (err) {
    const gitError = buildGitErrorFromCommand(args, cwd, err);
    throw new UserFacingError({
      code: USER_FACING_ERROR_CODES.git,
      title: "Git branch creation failed.",
      message: `Unable to create ${branch} from ${startPoint}.`,
      hint: "Make sure the start point exists locally.",
      cause: gitError,
    });
  }
}

// =============================================================================
// ERROR HELPERS
// =============================================================================

function buildGitErrorFromCommand(args: string[], cwd: string | undefined, err: unknown): GitError {
  const { stdout, stderr, message } = resolveExecaErrorOutput(err);
  const detail = stderr || message || "Unknown git error.";
  const location = cwd ? ` (cwd=${cwd})` : "";
  return new GitError(`git ${args.join(" ")} failed${location}: ${detail}`, { stdout, stderr });
}

function resolveExecaErrorOutput(err: unknown): {
  stdout: string;
  stderr: string;
  message: string;
} {
  if (!err || typeof err !== "object") {
    return { stdout: "", stderr: "", message: String(err) };
  }

  const record = err as Record<string, unknown>;
  const stdoutRaw = record.stdout;
  const stderrRaw = record.stderr;
  const stdout = typeof stdoutRaw === "string" ? stdoutRaw : stdoutRaw ? String(stdoutRaw) : "";
  const stderr = typeof stderrRaw === "string" ? stderrRaw : stderrRaw ? String(stderrRaw) : "";
  const message = typeof record.message === "string" ? record.message : String(err);

  return { stdout, stderr, message };
}
