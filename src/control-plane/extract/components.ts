// Control plane component extraction.
// Purpose: discover components from workspaces or top-level folders with simple heuristics.
// Assumes workspaces take precedence over the fallback directory scan.

import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import { slugify } from "../../core/utils.js";
import type { ComponentKind, ControlPlaneComponent } from "../model/schema.js";

export type ComponentDiscoverySource = "workspaces" | "directories";

export type ComponentDiscoveryResult = {
  components: ControlPlaneComponent[];
  source: ComponentDiscoverySource;
};

type ComponentCandidate = {
  name: string;
  roots: string[];
  kind: ComponentKind;
  language_hints?: string[];
};

const IGNORED_TOP_LEVEL_DIRS = new Set([
  "node_modules",
  ".git",
  ".mycelium",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "vendor",
]);

const LANGUAGE_HINT_SETS: Array<{ hint: string; files: string[] }> = [
  { hint: "py", files: ["pyproject.toml", "setup.py", "requirements.txt"] },
  { hint: "go", files: ["go.mod"] },
  { hint: "rust", files: ["Cargo.toml"] },
  { hint: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
];

const KIND_RULES: Array<{ kind: ComponentKind; tokens: string[] }> = [
  {
    kind: "infra",
    tokens: ["infra", "infrastructure", "ops", "devops", "deploy", "terraform", "k8s", "kube"],
  },
  {
    kind: "app",
    tokens: ["app", "apps", "service", "services", "web", "frontend", "ui", "cli", "api"],
  },
  {
    kind: "lib",
    tokens: ["lib", "libs", "library", "packages", "pkg", "shared", "common"],
  },
];

// =============================================================================
// PUBLIC API
// =============================================================================

export async function extractComponents(repoRoot: string): Promise<ComponentDiscoveryResult> {
  const packageJson = await readJsonIfPresent(path.join(repoRoot, "package.json"));
  const workspaceGlobs = extractWorkspaceGlobs(packageJson);

  if (workspaceGlobs.length > 0) {
    const components = await discoverWorkspaceComponents(repoRoot, workspaceGlobs);
    return { components, source: "workspaces" };
  }

  const components = await discoverDirectoryComponents(repoRoot);
  return { components, source: "directories" };
}

// =============================================================================
// WORKSPACE DISCOVERY
// =============================================================================

async function discoverWorkspaceComponents(
  repoRoot: string,
  workspaceGlobs: string[],
): Promise<ControlPlaneComponent[]> {
  const workspaceDirs = await fg(workspaceGlobs, {
    cwd: repoRoot,
    onlyDirectories: true,
    absolute: true,
    unique: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.mycelium/**"],
  });

  workspaceDirs.sort((a, b) => a.localeCompare(b));

  const candidates = await Promise.all(
    workspaceDirs.map((workspaceDir) => buildWorkspaceCandidate(repoRoot, workspaceDir)),
  );

  candidates.sort(compareComponentCandidates);
  return assignComponentIds(candidates);
}

async function buildWorkspaceCandidate(
  repoRoot: string,
  workspaceDir: string,
): Promise<ComponentCandidate> {
  const packageJson = await readJsonIfPresent(path.join(workspaceDir, "package.json"));
  const name = resolvePackageName(packageJson) ?? path.basename(workspaceDir);
  const root = toRepoRelativePath(repoRoot, workspaceDir);
  const kind = inferKind(name, [root]);
  const languageHints = await inferLanguageHints(workspaceDir);

  return {
    name,
    roots: [root],
    kind,
    language_hints: languageHints,
  };
}

// =============================================================================
// DIRECTORY FALLBACK
// =============================================================================

async function discoverDirectoryComponents(repoRoot: string): Promise<ControlPlaneComponent[]> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .filter((name) => !IGNORED_TOP_LEVEL_DIRS.has(name))
    .sort((a, b) => a.localeCompare(b));

  const candidates = await Promise.all(
    directories.map((dirName) => buildDirectoryCandidate(repoRoot, dirName)),
  );

  candidates.sort(compareComponentCandidates);
  return assignComponentIds(candidates);
}

async function buildDirectoryCandidate(
  repoRoot: string,
  dirName: string,
): Promise<ComponentCandidate> {
  const rootPath = path.join(repoRoot, dirName);
  const root = normalizeRepoPath(dirName);
  const kind = inferKind(dirName, [root]);
  const languageHints = await inferLanguageHints(rootPath);

  return {
    name: dirName,
    roots: [root],
    kind,
    language_hints: languageHints,
  };
}

// =============================================================================
// COMPONENT HELPERS
// =============================================================================

function assignComponentIds(candidates: ComponentCandidate[]): ControlPlaneComponent[] {
  const usedIds = new Set<string>();

  return candidates.map((candidate) => {
    const id = createUniqueComponentId(candidate.name, usedIds);
    const component: ControlPlaneComponent = {
      id,
      name: candidate.name,
      roots: candidate.roots,
      kind: candidate.kind,
    };

    if (candidate.language_hints && candidate.language_hints.length > 0) {
      component.language_hints = candidate.language_hints;
    }

    return component;
  });
}

function createUniqueComponentId(base: string, usedIds: Set<string>): string {
  const slug = slugify(base);
  const baseId = slug.length > 0 ? slug : "component";
  let candidate = baseId;
  let counter = 2;

  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${counter}`;
    counter += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function compareComponentCandidates(a: ComponentCandidate, b: ComponentCandidate): number {
  const rootA = a.roots[0] ?? "";
  const rootB = b.roots[0] ?? "";
  if (rootA !== rootB) {
    return rootA.localeCompare(rootB);
  }
  return a.name.localeCompare(b.name);
}

function inferKind(name: string, roots: string[]): ComponentKind {
  const haystack = [name, ...roots].join(" ").toLowerCase();

  for (const rule of KIND_RULES) {
    if (rule.tokens.some((token) => haystack.includes(token))) {
      return rule.kind;
    }
  }

  return "unknown";
}

async function inferLanguageHints(rootPath: string): Promise<string[] | undefined> {
  const hints = new Set<string>();

  const hasTsConfig = await fse.pathExists(path.join(rootPath, "tsconfig.json"));
  if (hasTsConfig) {
    hints.add("ts");
  } else if (await fse.pathExists(path.join(rootPath, "package.json"))) {
    hints.add("js");
  }

  for (const hintSet of LANGUAGE_HINT_SETS) {
    if (await hasAnyFile(rootPath, hintSet.files)) {
      hints.add(hintSet.hint);
    }
  }

  const ordered = Array.from(hints).sort();
  return ordered.length > 0 ? ordered : undefined;
}

async function hasAnyFile(rootPath: string, fileNames: string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await fse.pathExists(path.join(rootPath, fileName))) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// PACKAGE JSON
// =============================================================================

function extractWorkspaceGlobs(packageJson: unknown): string[] {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }

  if (!("workspaces" in packageJson)) {
    return [];
  }

  const workspaces = (packageJson as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter(isNonEmptyString);
  }

  if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter(isNonEmptyString);
    }
  }

  return [];
}

function resolvePackageName(packageJson: unknown): string | null {
  if (!packageJson || typeof packageJson !== "object") {
    return null;
  }

  const name = (packageJson as { name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fse.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return normalizeRepoPath(relativePath);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  return withoutDot.replace(/\/+$/, "");
}
