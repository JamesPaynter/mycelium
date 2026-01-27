// Control plane TypeScript import dependency extraction.
// Purpose: derive component edges by scanning .ts/.tsx imports for workspace packages.
// Assumes workspace package names are resolved from root workspaces + package.json names.

import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import type { ControlPlaneComponent, ControlPlaneDependencyEdge } from "../model/schema.js";

export type TypeScriptImportDependencyExtractionOptions = {
  repoRoot: string;
  components: ControlPlaneComponent[];
};

type WorkspacePackage = {
  name: string;
  component_id: string;
};

const TS_FILE_GLOBS = ["**/*.ts", "**/*.tsx"];
const TS_FILE_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.mycelium/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/tmp/**",
  "**/temp/**",
  "**/vendor/**",
  "**/*.d.ts",
];

const IMPORT_EXPORT_REGEX =
  /(?:^|\s)(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_REGEX = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function extractTypeScriptImportDependencyEdges(
  options: TypeScriptImportDependencyExtractionOptions,
): Promise<ControlPlaneDependencyEdge[]> {
  const workspacePackages = await loadWorkspacePackages(options.repoRoot, options.components);
  if (workspacePackages.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const workspacePackagesByName = indexWorkspacePackagesByName(workspacePackages);
  const edges: ControlPlaneDependencyEdge[] = [];

  for (const component of options.components) {
    const componentEdges = await collectEdgesForComponent(
      options.repoRoot,
      component,
      workspacePackagesByName,
      seen,
    );
    edges.push(...componentEdges);
  }

  return edges;
}

// =============================================================================
// EDGE COLLECTION
// =============================================================================

async function collectEdgesForComponent(
  repoRoot: string,
  component: ControlPlaneComponent,
  workspacePackagesByName: Map<string, string[]>,
  seen: Set<string>,
): Promise<ControlPlaneDependencyEdge[]> {
  const roots = component.roots.map((root) => path.join(repoRoot, root));
  const files = await findTypeScriptFiles(roots);
  const edges: ControlPlaneDependencyEdge[] = [];
  for (const filePath of files) {
    const fileEdges = await collectEdgesForFile(
      filePath,
      component.id,
      workspacePackagesByName,
      seen,
    );
    edges.push(...fileEdges);
  }

  return edges;
}

async function collectEdgesForFile(
  filePath: string,
  componentId: string,
  workspacePackagesByName: Map<string, string[]>,
  seen: Set<string>,
): Promise<ControlPlaneDependencyEdge[]> {
  const source = await fs.readFile(filePath, "utf8");
  const specifiers = extractImportSpecifiers(source);
  const edges: ControlPlaneDependencyEdge[] = [];
  for (const specifier of specifiers) {
    appendEdgesForSpecifier(
      specifier,
      componentId,
      workspacePackagesByName,
      seen,
      edges,
    );
  }

  return edges;
}

function appendEdgesForSpecifier(
  specifier: string,
  componentId: string,
  workspacePackagesByName: Map<string, string[]>,
  seen: Set<string>,
  edges: ControlPlaneDependencyEdge[],
): void {
  if (shouldIgnoreSpecifier(specifier)) {
    return;
  }

  const matches = resolveWorkspaceTargets(specifier, workspacePackagesByName);
  if (matches.length === 0) {
    return;
  }
  const confidence = matches.length > 1 ? "low" : "medium";
  for (const targetId of matches) {
    const edge = buildDependencyEdge(componentId, targetId, confidence);
    if (!edge) {
      continue;
    }

    if (!registerEdge(edge, seen)) {
      continue;
    }
    edges.push(edge);
  }
}

function buildDependencyEdge(
  fromComponentId: string,
  toComponentId: string,
  confidence: ControlPlaneDependencyEdge["confidence"],
): ControlPlaneDependencyEdge | null {
  if (toComponentId === fromComponentId) {
    return null;
  }

  return {
    from_component: fromComponentId,
    to_component: toComponentId,
    kind: "ts-import",
    confidence,
  };
}

function registerEdge(edge: ControlPlaneDependencyEdge, seen: Set<string>): boolean {
  const key = buildEdgeKey(edge);
  if (seen.has(key)) {
    return false;
  }

  seen.add(key);
  return true;
}

function buildEdgeKey(edge: ControlPlaneDependencyEdge): string {
  return `${edge.from_component}::${edge.to_component}::${edge.kind}::${edge.confidence}`;
}

// =============================================================================
// WORKSPACE PACKAGE LOADING
// =============================================================================

async function loadWorkspacePackages(
  repoRoot: string,
  components: ControlPlaneComponent[],
): Promise<WorkspacePackage[]> {
  const workspaceGlobs = await loadWorkspaceGlobs(repoRoot);
  if (workspaceGlobs.length === 0) {
    return [];
  }

  const componentByRoot = buildComponentRootIndex(components);
  const workspaceDirs = await fg(workspaceGlobs, {
    cwd: repoRoot,
    onlyDirectories: true,
    absolute: true,
    unique: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.mycelium/**"],
  });

  workspaceDirs.sort((a, b) => a.localeCompare(b));

  const packages: WorkspacePackage[] = [];
  for (const workspaceDir of workspaceDirs) {
    const root = toRepoRelativePath(repoRoot, workspaceDir);
    const component = componentByRoot.get(root);
    if (!component) {
      continue;
    }

    const packageJson = await readJsonIfPresent(path.join(workspaceDir, "package.json"));
    const name = resolvePackageName(packageJson);
    if (!name) {
      continue;
    }

    packages.push({ name, component_id: component.id });
  }

  return packages;
}

function indexWorkspacePackagesByName(packages: WorkspacePackage[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const pkg of packages) {
    const existing = index.get(pkg.name);
    if (existing) {
      if (!existing.includes(pkg.component_id)) {
        existing.push(pkg.component_id);
      }
      continue;
    }

    index.set(pkg.name, [pkg.component_id]);
  }

  return index;
}

// =============================================================================
// IMPORT SCANNING
// =============================================================================

async function findTypeScriptFiles(roots: string[]): Promise<string[]> {
  const matches = await Promise.all(
    roots.map((root) =>
      fg(TS_FILE_GLOBS, {
        cwd: root,
        absolute: true,
        unique: true,
        suppressErrors: true,
        ignore: TS_FILE_IGNORES,
      }),
    ),
  );

  const files = matches.flat();
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  for (const regex of [IMPORT_EXPORT_REGEX, DYNAMIC_IMPORT_REGEX]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }

  return Array.from(specifiers);
}

function shouldIgnoreSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function resolveWorkspaceTargets(
  specifier: string,
  workspacePackagesByName: Map<string, string[]>,
): string[] {
  const matches = new Set<string>();

  for (const [packageName, componentIds] of workspacePackagesByName) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      for (const componentId of componentIds) {
        matches.add(componentId);
      }
    }
  }

  return Array.from(matches);
}

// =============================================================================
// PACKAGE JSON HELPERS
// =============================================================================

async function loadWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const packageJson = await readJsonIfPresent(path.join(repoRoot, "package.json"));
  return extractWorkspaceGlobs(packageJson);
}

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

// =============================================================================
// PATH HELPERS
// =============================================================================

function buildComponentRootIndex(
  components: ControlPlaneComponent[],
): Map<string, ControlPlaneComponent> {
  const index = new Map<string, ControlPlaneComponent>();

  for (const component of components) {
    for (const rawRoot of component.roots) {
      index.set(normalizeRepoPath(rawRoot), component);
    }
  }

  return index;
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return normalizeRepoPath(relativePath);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}
