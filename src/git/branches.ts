import path from "node:path";
import fse from "fs-extra";
import { execa } from "execa";
import { GitError } from "../core/errors.js";
import { ensureDir } from "../core/utils.js";

export async function cloneRepo(opts: {
  sourceRepo: string;
  destDir: string;
  branch?: string;
}): Promise<void> {
  await ensureDir(path.dirname(opts.destDir));
  // Remove existing directory if present (we always recreate).
  await fse.remove(opts.destDir);

  const args = [
    "clone",
    "--no-hardlinks",
    opts.sourceRepo,
    opts.destDir
  ];
  if (opts.branch) {
    // NOTE: Cannot use --branch with local source reliably for detached? It's ok.
  }

  try {
    await execa("git", args, { stdio: "pipe" });
  } catch (err: any) {
    throw new GitError(`git clone failed: ${err?.stderr ?? err?.message ?? String(err)}`);
  }
}

export async function checkoutBranchInClone(cwd: string, branch: string): Promise<void> {
  await execa("git", ["checkout", branch], { cwd, stdio: "pipe" });
}

export async function createBranchInClone(cwd: string, branch: string, startPoint: string): Promise<void> {
  await execa("git", ["checkout", "-b", branch, startPoint], { cwd, stdio: "pipe" });
}
