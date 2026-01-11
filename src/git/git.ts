import { execa, type Options } from "execa";

import { GitError } from "../core/errors.js";

export async function git(
  cwd: string,
  args: string[],
  opts: Options = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const res = await execa("git", args, {
      cwd,
      stdio: "pipe",
      env: process.env,
      ...opts,
    });
    const stdout = typeof res.stdout === "string" ? res.stdout : String(res.stdout ?? "");
    const stderr = typeof res.stderr === "string" ? res.stderr : String(res.stderr ?? "");
    return { stdout, stderr, exitCode: res.exitCode ?? -1 };
  } catch (err: any) {
    const stdoutValue = err?.stdout ?? "";
    const stderrValue = err?.stderr ?? err?.message ?? "";
    const stdout = typeof stdoutValue === "string" ? stdoutValue : String(stdoutValue);
    const stderr = typeof stderrValue === "string" ? stderrValue : String(stderrValue);
    throw new GitError(`git ${args.join(" ")} failed (cwd=${cwd}): ${stderr}`, { stdout, stderr });
  }
}

export async function ensureCleanWorkingTree(cwd: string): Promise<void> {
  // Ignore untracked files (e.g., .tasks/, logs/) so the tool can operate without
  // requiring those artifacts to be committed.
  const res = await execa("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd,
    stdio: "pipe",
  });
  if (res.stdout.trim().length > 0) {
    throw new GitError(
      `Repository has uncommitted changes (cwd=${cwd}). Please commit/stash before running.`,
    );
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  const res = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdio: "pipe" });
  return res.stdout.trim();
}

export async function headSha(cwd: string): Promise<string> {
  const res = await execa("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" });
  return res.stdout.trim();
}

export async function getRemoteUrl(cwd: string, remote = "origin"): Promise<string | null> {
  try {
    const res = await git(cwd, ["config", "--get", `remote.${remote}.url`]);
    const url = res.stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["checkout", branch]);
}

export async function checkoutNewBranch(
  cwd: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(cwd, ["checkout", "-b", branch, startPoint]);
}

export async function mergeNoFf(cwd: string, ref: string, message?: string): Promise<void> {
  const args = ["merge", "--no-ff", ref];
  if (message) {
    args.push("-m", message);
  }
  await git(cwd, args);
}

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await git(cwd, ["remote", "add", name, url]);
}

export async function removeRemote(cwd: string, name: string): Promise<void> {
  await git(cwd, ["remote", "remove", name]);
}

export async function fetchRemote(cwd: string, name: string, refspec: string): Promise<void> {
  await git(cwd, ["fetch", name, refspec]);
}

export async function deleteLocalBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["branch", "-D", branch]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", branch]);
    return true;
  } catch {
    return false;
  }
}
