import path from "node:path";

import { minimatch } from "minimatch";

import type { ManifestEnforcementPolicy, ResourceConfig } from "./config.js";
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

export type ManifestComplianceViolation = {
  path: string;
  resources: string[];
  reasons: AccessRequestReason[];
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
};

export type ManifestComplianceArgs = {
  workspacePath: string;
  mainBranch: string;
  manifest: TaskManifest;
  resources: ResourceConfig[];
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

  const changedFiles = await collectChangedFiles(args.workspacePath, args.mainBranch, args.resources);
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

async function collectChangedFiles(
  workspacePath: string,
  mainBranch: string,
  resources: ResourceConfig[],
): Promise<FileResource[]> {
  const changed = await listChangedFiles(workspacePath, mainBranch);
  return changed.map((file) => ({
    path: file,
    resources: matchResources(file, resources),
  }));
}

function findViolations(files: FileResource[], manifest: TaskManifest): ManifestComplianceViolation[] {
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
      violations.push({ path: file.path, resources: file.resources, reasons });
    }
  }

  return violations;
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
