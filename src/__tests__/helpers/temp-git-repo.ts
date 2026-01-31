import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

// =============================================================================
// TYPES
// =============================================================================

export type TempGitRepo = {
  repoDir: string;
  writeFile: (relPath: string, contents: string) => Promise<void>;
  rm: (relPath: string) => Promise<void>;
  mv: (from: string, to: string) => Promise<void>;
  commit: (message: string) => Promise<string>;
  git: (args: string[]) => Promise<string>;
  exec: (cmd: string, args: string[]) => Promise<string>;
  cleanup: () => Promise<void>;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function createTempGitRepo(): Promise<TempGitRepo> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-git-"));
  const repoDir = path.join(tempRoot, "repo");

  await fs.mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);

  const exec = async (cmd: string, args: string[]): Promise<string> => {
    const result = await execa(cmd, args, { cwd: repoDir });
    return result.stdout;
  };

  const git = async (args: string[]): Promise<string> => {
    const result = await execa("git", ["-C", repoDir, ...args]);
    return result.stdout;
  };

  const writeFile = async (relPath: string, contents: string): Promise<void> => {
    const absolutePath = path.join(repoDir, relPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const normalizedContents = normalizeLineEndings(contents);
    await fs.writeFile(absolutePath, normalizedContents, "utf8");
  };

  const rm = async (relPath: string): Promise<void> => {
    const absolutePath = path.join(repoDir, relPath);
    await fs.rm(absolutePath, { recursive: true, force: true });
  };

  const mv = async (from: string, to: string): Promise<void> => {
    const fromPath = path.join(repoDir, from);
    const toPath = path.join(repoDir, to);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
  };

  const commit = async (message: string): Promise<string> => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    const sha = await git(["rev-parse", "HEAD"]);
    return sha.trim();
  };

  const cleanup = async (): Promise<void> => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  };

  return { repoDir, writeFile, rm, mv, commit, git, exec, cleanup };
}

// =============================================================================
// INTERNALS
// =============================================================================

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "mycelium-test"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "mycelium-test@example.com"], {
    cwd: repoDir,
  });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

function normalizeLineEndings(contents: string): string {
  return contents.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
