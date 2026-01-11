import fs from "node:fs";
import path from "node:path";
import fse from "fs-extra";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function defaultRunId(): string {
  // YYYYMMDD-HHMMSS
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fse.ensureDir(dir);
}

export async function pathExists(p: string): Promise<boolean> {
  return fse.pathExists(p);
}

export async function readTextFile(filePath: string): Promise<string> {
  return fse.readFile(filePath, "utf8");
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const raw = await fse.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, ".git"));
}
