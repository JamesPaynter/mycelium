import path from "node:path";

import type { ManifestComplianceResult } from "./manifest-compliance.js";
import { normalizeTaskManifest, type TaskManifest } from "./task-manifest.js";

export type RescopeComputation =
  | { status: "updated"; manifest: TaskManifest; addedLocks: string[]; addedFiles: string[] }
  | { status: "noop"; reason: string }
  | { status: "failed"; reason: string };

export function describeManifestViolations(result: ManifestComplianceResult): string {
  const count = result.violations.length;
  const example = result.violations[0]?.path;
  const detail = example ? ` (example: ${example})` : "";
  return `${count} undeclared access request(s)${detail}`;
}

export function computeRescopeFromCompliance(
  manifest: TaskManifest,
  compliance: ManifestComplianceResult,
): RescopeComputation {
  if (compliance.violations.length === 0) {
    return { status: "noop", reason: "No compliance violations to rescope" };
  }

  const existing = buildExistingScopeSets(manifest);
  const updateResult = collectComplianceRescopeUpdates(compliance, existing);

  if (updateResult.status === "failed") {
    return { status: "failed", reason: updateResult.reason };
  }

  return finalizeRescopeManifest(
    manifest,
    updateResult.updates,
    "Compliance violations present but no new locks/files to add",
  );
}

export function computeRescopeFromComponentScope(input: {
  manifest: TaskManifest;
  componentResourcePrefix: string;
  missingComponents: string[];
  changedFiles: string[];
}): RescopeComputation {
  if (input.missingComponents.length === 0 && input.changedFiles.length === 0) {
    return { status: "noop", reason: "No component scope drift detected" };
  }

  const prefix = input.componentResourcePrefix.trim();
  if (!prefix) {
    return { status: "failed", reason: "Cannot rescope: component resource prefix missing" };
  }

  const existing = buildExistingScopeSets(input.manifest);
  const updates = collectComponentScopeUpdates({
    prefix,
    missingComponents: input.missingComponents,
    changedFiles: input.changedFiles,
    existing,
  });

  return finalizeRescopeManifest(
    input.manifest,
    updates,
    "Component scope drift detected but no new locks/files to add",
  );
}

type ExistingScopeSets = {
  locks: Set<string>;
  writeFiles: Set<string>;
  readFiles: Set<string>;
};

type RescopeUpdates = {
  addedLocks: Set<string>;
  addedFiles: Set<string>;
};

type ComplianceUpdateResult =
  | { status: "ok"; updates: RescopeUpdates }
  | { status: "failed"; reason: string };

function buildExistingScopeSets(manifest: TaskManifest): ExistingScopeSets {
  return {
    locks: new Set(manifest.locks.writes ?? []),
    writeFiles: new Set(manifest.files.writes ?? []),
    readFiles: new Set(manifest.files.reads ?? []),
  };
}

function collectComplianceRescopeUpdates(
  compliance: ManifestComplianceResult,
  existing: ExistingScopeSets,
): ComplianceUpdateResult {
  const updates = createRescopeUpdates();

  for (const violation of compliance.violations) {
    if (isMissingResourceMapping(violation)) {
      return {
        status: "failed",
        reason: `Cannot rescope: resource mapping missing for ${violation.path}`,
      };
    }

    if (violation.reasons.includes("resource_not_locked_for_write")) {
      for (const res of violation.resources) {
        addLockIfMissing(res, existing, updates);
      }
    }

    if (violation.reasons.includes("file_not_declared_for_write")) {
      addFileIfMissing(violation.path, existing, updates);
    }
  }

  return { status: "ok", updates };
}

function collectComponentScopeUpdates(input: {
  prefix: string;
  missingComponents: string[];
  changedFiles: string[];
  existing: ExistingScopeSets;
}): RescopeUpdates {
  const updates = createRescopeUpdates();

  for (const componentId of input.missingComponents) {
    addLockIfMissing(`${input.prefix}${componentId}`, input.existing, updates);
  }

  for (const file of input.changedFiles) {
    addFileIfMissing(file, input.existing, updates);
  }

  return updates;
}

function finalizeRescopeManifest(
  manifest: TaskManifest,
  updates: RescopeUpdates,
  emptyReason: string,
): RescopeComputation {
  if (updates.addedLocks.size === 0 && updates.addedFiles.size === 0) {
    return { status: "noop", reason: emptyReason };
  }

  const nextManifest = normalizeTaskManifest({
    ...manifest,
    locks: {
      reads: manifest.locks.reads ?? [],
      writes: [...(manifest.locks.writes ?? []), ...updates.addedLocks],
    },
    files: {
      reads: [...(manifest.files.reads ?? []), ...updates.addedFiles],
      writes: [...(manifest.files.writes ?? []), ...updates.addedFiles],
    },
  });

  return {
    status: "updated",
    manifest: nextManifest,
    addedLocks: Array.from(updates.addedLocks).sort(),
    addedFiles: Array.from(updates.addedFiles).sort(),
  };
}

function createRescopeUpdates(): RescopeUpdates {
  return { addedLocks: new Set<string>(), addedFiles: new Set<string>() };
}

function isMissingResourceMapping(violation: ManifestComplianceResult["violations"][number]): boolean {
  return violation.reasons.includes("resource_unmapped") && violation.resources.length === 0;
}

function addLockIfMissing(
  lockName: string,
  existing: ExistingScopeSets,
  updates: RescopeUpdates,
): void {
  if (!existing.locks.has(lockName)) {
    updates.addedLocks.add(lockName);
  }
}

function addFileIfMissing(
  filePath: string,
  existing: ExistingScopeSets,
  updates: RescopeUpdates,
): void {
  const normalizedPath = toPosixPath(filePath);
  if (!existing.writeFiles.has(normalizedPath) && !existing.readFiles.has(normalizedPath)) {
    updates.addedFiles.add(normalizedPath);
  }
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
