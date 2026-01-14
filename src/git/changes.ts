import path from "node:path";

import { execa } from "execa";

// =============================================================================
// TYPES
// =============================================================================

export type ChangedFile = {
  path: string;
  status: string;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function listChangedFiles(cwd: string, baseRef: string): Promise<string[]> {
  const files = new Set<string>();

  const diff = await execa("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((file) => files.add(normalizePath(file)));

  const status = await execa("git", ["status", "--porcelain"], { cwd, reject: false, stdio: "pipe" });
  status.stdout
    .split("\n")
    .map(parseStatusPath)
    .filter(Boolean)
    .forEach((file) => files.add(normalizePath(file as string)));

  return Array.from(files)
    .filter((file) => file.length > 0 && !file.endsWith("/"))
    .sort();
}

// =============================================================================
// INTERNALS
// =============================================================================

function parseStatusPath(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const arrowIndex = trimmed.indexOf("->");
  if (arrowIndex !== -1) {
    return trimmed.slice(arrowIndex + 2).trim();
  }

  const parts = trimmed.split(/\s+/);
  return parts.length >= 2 ? parts.slice(1).join(" ").trim() : null;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
