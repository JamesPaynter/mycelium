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

  const existingLocks = new Set(manifest.locks.writes ?? []);
  const existingWriteFiles = new Set(manifest.files.writes ?? []);
  const existingReadFiles = new Set(manifest.files.reads ?? []);

  const addedLocks = new Set<string>();
  const addedFiles = new Set<string>();

  for (const violation of compliance.violations) {
    if (violation.reasons.includes("resource_unmapped") && violation.resources.length === 0) {
      return {
        status: "failed",
        reason: `Cannot rescope: resource mapping missing for ${violation.path}`,
      };
    }

    if (violation.reasons.includes("resource_not_locked_for_write")) {
      for (const res of violation.resources) {
        if (!existingLocks.has(res)) {
          addedLocks.add(res);
        }
      }
    }

    if (violation.reasons.includes("file_not_declared_for_write")) {
      const normalizedPath = toPosixPath(violation.path);
      if (!existingWriteFiles.has(normalizedPath) && !existingReadFiles.has(normalizedPath)) {
        addedFiles.add(normalizedPath);
      }
    }
  }

  if (addedLocks.size === 0 && addedFiles.size === 0) {
    return {
      status: "noop",
      reason: "Compliance violations present but no new locks/files to add",
    };
  }

  const nextManifest = normalizeTaskManifest({
    ...manifest,
    locks: {
      reads: manifest.locks.reads ?? [],
      writes: [...(manifest.locks.writes ?? []), ...addedLocks],
    },
    files: {
      reads: [...(manifest.files.reads ?? []), ...addedFiles],
      writes: [...(manifest.files.writes ?? []), ...addedFiles],
    },
  });

  return {
    status: "updated",
    manifest: nextManifest,
    addedLocks: Array.from(addedLocks).sort(),
    addedFiles: Array.from(addedFiles).sort(),
  };
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

  const existingLocks = new Set(input.manifest.locks.writes ?? []);
  const existingWriteFiles = new Set(input.manifest.files.writes ?? []);
  const existingReadFiles = new Set(input.manifest.files.reads ?? []);

  const addedLocks = new Set<string>();
  const addedFiles = new Set<string>();

  for (const componentId of input.missingComponents) {
    const lockName = `${prefix}${componentId}`;
    if (!existingLocks.has(lockName)) {
      addedLocks.add(lockName);
    }
  }

  for (const file of input.changedFiles) {
    const normalizedPath = toPosixPath(file);
    if (!existingWriteFiles.has(normalizedPath) && !existingReadFiles.has(normalizedPath)) {
      addedFiles.add(normalizedPath);
    }
  }

  if (addedLocks.size === 0 && addedFiles.size === 0) {
    return {
      status: "noop",
      reason: "Component scope drift detected but no new locks/files to add",
    };
  }

  const nextManifest = normalizeTaskManifest({
    ...input.manifest,
    locks: {
      reads: input.manifest.locks.reads ?? [],
      writes: [...(input.manifest.locks.writes ?? []), ...addedLocks],
    },
    files: {
      reads: [...(input.manifest.files.reads ?? []), ...addedFiles],
      writes: [...(input.manifest.files.writes ?? []), ...addedFiles],
    },
  });

  return {
    status: "updated",
    manifest: nextManifest,
    addedLocks: Array.from(addedLocks).sort(),
    addedFiles: Array.from(addedFiles).sort(),
  };
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
