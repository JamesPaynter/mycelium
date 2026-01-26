import path from "node:path";

import { minimatch } from "minimatch";

import type {
  ControlPlaneResourcesMode,
  ManifestEnforcementPolicy,
  ResourceConfig,
} from "./config.js";
import type { TaskManifest } from "./task-manifest.js";
import { listChangedFiles } from "../git/changes.js";
import { writeJsonFile } from "./utils.js";

// =============================================================================
// TYPES
// =============================================================================

export type AccessRequestReason =
  | "resource_not_locked_for_write"
  | "file_not_declared_for_write"
  | "resource_unmapped";

export type ResourceOwnershipDetail = {
  component_id: string;
  component_name?: string;
  resource: string;
  root: string;
};

export type ResourceOwnershipResolver = (filePath: string) => ResourceOwnershipDetail[] | null;

export type ManifestComplianceGuidance = {
  action: "expand_scope" | "split_task";
  detail: string;
};

export type ManifestComplianceViolation = {
  path: string;
  resources: string[];
  reasons: AccessRequestReason[];
  component_owners?: ResourceOwnershipDetail[];
  guidance?: ManifestComplianceGuidance[];
};

export type ManifestComplianceStatus = "skipped" | "pass" | "warn" | "block";

export type ManifestComplianceResult = {
  policy: ManifestEnforcementPolicy;
  status: ManifestComplianceStatus;
  changedFiles: FileResource[];
  violations: ManifestComplianceViolation[];
  report: ManifestComplianceReport;
};

export type ManifestComplianceReport = {
  task_id: string;
  task_name: string;
  policy: ManifestEnforcementPolicy;
  status: ManifestComplianceStatus;
  changed_files: FileResource[];
  violations: ManifestComplianceViolation[];
  manifest: {
    locks: TaskManifest["locks"];
    files: TaskManifest["files"];
  };
};

type FileResource = {
  path: string;
  resources: string[];
  component_owners?: ResourceOwnershipDetail[];
};

export type ResourceOwnerResolver = (filePath: string) => string | null;

export type ResolveResourcesOptions = {
  ownerResolver?: ResourceOwnerResolver;
  staticResources: ResourceConfig[];
  fallbackResource: string;
  resourcesMode?: ControlPlaneResourcesMode;
};

export type ManifestComplianceArgs = {
  workspacePath: string;
  mainBranch: string;
  manifest: TaskManifest;
  resources: ResourceConfig[];
  staticResources?: ResourceConfig[];
  fallbackResource: string;
  ownerResolver?: ResourceOwnerResolver;
  ownershipResolver?: ResourceOwnershipResolver;
  resourcesMode?: ControlPlaneResourcesMode;
  policy: ManifestEnforcementPolicy;
  reportPath?: string;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runManifestCompliance(
  args: ManifestComplianceArgs,
): Promise<ManifestComplianceResult> {
  if (args.policy === "off") {
    const report = buildReport({
      manifest: args.manifest,
      changedFiles: [],
      violations: [],
      policy: args.policy,
    });

    if (args.reportPath) {
      await writeJsonFile(args.reportPath, report);
    }

    return {
      policy: args.policy,
      status: "skipped",
      changedFiles: [],
      violations: [],
      report,
    };
  }

  const changedFiles = await collectChangedFiles({
    workspacePath: args.workspacePath,
    mainBranch: args.mainBranch,
    staticResources: args.staticResources ?? args.resources,
    fallbackResource: args.fallbackResource,
    ownerResolver: args.ownerResolver,
    ownershipResolver: args.ownershipResolver,
    resourcesMode: args.resourcesMode,
  });
  const violations = findViolations(changedFiles, args.manifest);
  const status: ManifestComplianceStatus =
    violations.length === 0 ? "pass" : args.policy === "block" ? "block" : "warn";

  const report = buildReport({
    manifest: args.manifest,
    changedFiles,
    violations,
    policy: args.policy,
  });

  if (args.reportPath) {
    await writeJsonFile(args.reportPath, report);
  }

  return { policy: args.policy, status, changedFiles, violations, report };
}

// =============================================================================
// INTERNALS
// =============================================================================

async function collectChangedFiles(input: {
  workspacePath: string;
  mainBranch: string;
  staticResources: ResourceConfig[];
  fallbackResource: string;
  ownerResolver?: ResourceOwnerResolver;
  ownershipResolver?: ResourceOwnershipResolver;
  resourcesMode?: ControlPlaneResourcesMode;
}): Promise<FileResource[]> {
  const changed = await listChangedFiles(input.workspacePath, input.mainBranch);
  return changed.map((file) => {
    const resources = resolveResourcesForFile(file, {
      ownerResolver: input.ownerResolver,
      staticResources: input.staticResources,
      fallbackResource: input.fallbackResource,
      resourcesMode: input.resourcesMode,
    });
    const componentOwners = resolveComponentOwners(file, resources, {
      ownershipResolver: input.ownershipResolver,
    });

    return {
      path: file,
      resources,
      ...(componentOwners ? { component_owners: componentOwners } : {}),
    };
  });
}

function findViolations(
  files: FileResource[],
  manifest: TaskManifest,
): ManifestComplianceViolation[] {
  const declaredLocks = new Set(manifest.locks.writes ?? []);
  const declaredFiles = manifest.files.writes ?? [];
  const violations: ManifestComplianceViolation[] = [];

  for (const file of files) {
    const reasons: AccessRequestReason[] = [];

    if (file.resources.length === 0) {
      reasons.push("resource_unmapped");
    } else {
      const missing = file.resources.filter((res) => !declaredLocks.has(res));
      if (missing.length > 0) {
        reasons.push("resource_not_locked_for_write");
      }
    }

    if (!isFileDeclared(file.path, declaredFiles)) {
      reasons.push("file_not_declared_for_write");
    }

    if (reasons.length > 0) {
      const guidance = buildViolationGuidance(file.component_owners);
      violations.push({
        path: file.path,
        resources: file.resources,
        reasons,
        ...(file.component_owners ? { component_owners: file.component_owners } : {}),
        ...(guidance ? { guidance } : {}),
      });
    }
  }

  return violations;
}

export function resolveResourcesForFile(file: string, options: ResolveResourcesOptions): string[] {
  const mode = options.resourcesMode ?? "prefer-derived";

  if (mode === "prefer-derived") {
    const ownedResource = options.ownerResolver?.(file) ?? null;
    if (ownedResource) {
      return [ownedResource];
    }
  }

  const matches = matchResources(file, options.staticResources);
  if (matches.length > 0) {
    return matches;
  }

  return options.fallbackResource ? [options.fallbackResource] : [];
}

function matchResources(file: string, resources: ResourceConfig[]): string[] {
  const normalizedFile = toPosixPath(file);
  const matches = new Set<string>();

  for (const res of resources) {
    for (const pattern of res.paths) {
      const normalizedPattern = toPosixPath(pattern);
      if (minimatch(normalizedFile, normalizedPattern, { dot: true })) {
        matches.add(res.name);
        break;
      }
    }
  }

  return Array.from(matches).sort();
}

function resolveComponentOwners(
  file: string,
  resources: string[],
  options: { ownershipResolver?: ResourceOwnershipResolver },
): ResourceOwnershipDetail[] | undefined {
  if (!options.ownershipResolver) {
    return undefined;
  }

  const owners = options.ownershipResolver(file) ?? [];
  if (owners.length === 0) {
    return undefined;
  }

  const resourceSet = new Set(resources);
  const filtered = owners.filter((owner) => resourceSet.has(owner.resource));
  if (filtered.length === 0) {
    return undefined;
  }

  return filtered;
}

function buildViolationGuidance(
  componentOwners?: ResourceOwnershipDetail[],
): ManifestComplianceGuidance[] | undefined {
  if (!componentOwners || componentOwners.length === 0) {
    return undefined;
  }

  const ownerSummary = formatComponentOwners(componentOwners);
  const resourceList = Array.from(new Set(componentOwners.map((owner) => owner.resource))).sort();
  const resourcesLabel = resourceList.join(", ");

  return [
    {
      action: "expand_scope",
      detail: ownerSummary
        ? `Expand scope to include ${ownerSummary} in manifest locks/files.`
        : `Expand scope to include ${resourcesLabel} in manifest locks/files.`,
    },
    {
      action: "split_task",
      detail:
        "Split the task by component if changes should remain within a single ownership boundary.",
    },
  ];
}

function formatComponentOwners(owners: ResourceOwnershipDetail[]): string {
  return owners.map((owner) => `${owner.resource} (root: ${owner.root})`).join(", ");
}

function isFileDeclared(file: string, patterns: string[]): boolean {
  const normalizedFile = toPosixPath(file);
  return patterns.some((pattern) =>
    minimatch(normalizedFile, toPosixPath(pattern), { dot: true, nocase: false }),
  );
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function buildReport(args: {
  manifest: TaskManifest;
  changedFiles: FileResource[];
  violations: ManifestComplianceViolation[];
  policy: ManifestEnforcementPolicy;
}): ManifestComplianceReport {
  return {
    task_id: args.manifest.id,
    task_name: args.manifest.name,
    policy: args.policy,
    status:
      args.policy === "off"
        ? "skipped"
        : args.violations.length === 0
          ? "pass"
          : args.policy === "block"
            ? "block"
            : "warn",
    changed_files: args.changedFiles,
    violations: args.violations,
    manifest: {
      locks: args.manifest.locks,
      files: args.manifest.files,
    },
  };
}
