// Control plane workspace dependency extraction.
// Purpose: derive component dependency edges from workspace package.json files.
// Assumes workspace globs are declared in the repo root package.json.

import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";

import type { ControlPlaneComponent, ControlPlaneDependencyEdge } from "../model/schema.js";

export type WorkspacePackageDependencyExtractionOptions = {
  repoRoot: string;
  components: ControlPlaneComponent[];
};

type WorkspaceDependencyField = "dependencies" | "devDependencies" | "peerDependencies";

type WorkspacePackageInfo = {
  name: string;
  component_id: string;
  dependency_names: Record<WorkspaceDependencyField, string[]>;
};

const WORKSPACE_DEPENDENCY_FIELDS: WorkspaceDependencyField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

// =============================================================================
// PUBLIC API
// =============================================================================

export async function extractWorkspacePackageDependencyEdges(
  options: WorkspacePackageDependencyExtractionOptions,
): Promise<ControlPlaneDependencyEdge[]> {
  const workspaceGlobs = await loadWorkspaceGlobs(options.repoRoot);
  if (workspaceGlobs.length === 0) {
    return [];
  }

  const componentByRoot = buildComponentRootIndex(options.components);
  const workspaceDirs = await fg(workspaceGlobs, {
    cwd: options.repoRoot,
    onlyDirectories: true,
    absolute: true,
    unique: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.mycelium/**"],
  });

  workspaceDirs.sort((a, b) => a.localeCompare(b));

  const workspacePackages = await Promise.all(
    workspaceDirs.map((dir) => loadWorkspacePackageInfo(options.repoRoot, dir, componentByRoot)),
  );

  const packages = workspacePackages.filter(isWorkspacePackageInfo);
  const componentIdsByName = indexWorkspacePackagesByName(packages);

  const edges: ControlPlaneDependencyEdge[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
      const dependencyNames = pkg.dependency_names[field];
      if (!dependencyNames || dependencyNames.length === 0) {
        continue;
      }

      for (const dependencyName of dependencyNames) {
        const targetIds = componentIdsByName.get(dependencyName);
        if (!targetIds || targetIds.length === 0) {
          continue;
        }

        for (const targetId of targetIds) {
          if (targetId === pkg.component_id) {
            continue;
          }

          const edge: ControlPlaneDependencyEdge = {
            from_component: pkg.component_id,
            to_component: targetId,
            kind: "workspace-package",
            confidence: "high",
          };

          const key = `${edge.from_component}::${edge.to_component}::${edge.kind}`;
          if (seen.has(key)) {
            continue;
          }

          edges.push(edge);
          seen.add(key);
        }
      }
    }
  }

  return edges;
}

// =============================================================================
// WORKSPACE PACKAGE LOADING
// =============================================================================

async function loadWorkspacePackageInfo(
  repoRoot: string,
  workspaceDir: string,
  componentByRoot: Map<string, ControlPlaneComponent>,
): Promise<WorkspacePackageInfo | null> {
  const root = toRepoRelativePath(repoRoot, workspaceDir);
  const component = componentByRoot.get(root);
  if (!component) {
    return null;
  }

  const packageJson = await readJsonIfPresent(path.join(workspaceDir, "package.json"));
  if (!packageJson) {
    return null;
  }

  const name = resolvePackageName(packageJson);
  if (!name) {
    return null;
  }

  return {
    name,
    component_id: component.id,
    dependency_names: {
      dependencies: extractDependencyNames(packageJson, "dependencies"),
      devDependencies: extractDependencyNames(packageJson, "devDependencies"),
      peerDependencies: extractDependencyNames(packageJson, "peerDependencies"),
    },
  };
}

function indexWorkspacePackagesByName(packages: WorkspacePackageInfo[]): Map<string, string[]> {
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

function extractDependencyNames(packageJson: unknown, field: WorkspaceDependencyField): string[] {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }

  const dependencies = (packageJson as Record<string, unknown>)[field];
  if (!dependencies || typeof dependencies !== "object") {
    return [];
  }

  return Object.entries(dependencies)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
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

function isWorkspacePackageInfo(entry: WorkspacePackageInfo | null): entry is WorkspacePackageInfo {
  return entry !== null;
}
