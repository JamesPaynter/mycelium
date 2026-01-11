import { z, type ZodIssue } from "zod";

export const LocksSchema = z
  .object({
    reads: z.array(z.string()).default([]),
    writes: z.array(z.string()).default([]),
  })
  .strict();

export const FilesSchema = z
  .object({
    reads: z.array(z.string()).default([]),
    writes: z.array(z.string()).default([]),
  })
  .strict();

export const VerifySchema = z
  .object({
    doctor: z.string().min(1),
    fast: z.string().optional(),
  })
  .strict();

export const TaskManifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    estimated_minutes: z.number().int().positive(),
    dependencies: z.array(z.string()).optional(),
    locks: LocksSchema.default({ reads: [], writes: [] }),
    files: FilesSchema.default({ reads: [], writes: [] }),
    affected_tests: z.array(z.string()).default([]),
    verify: VerifySchema,
  })
  .strict();

export type TaskManifest = z.infer<typeof TaskManifestSchema>;

export type TaskSpec = {
  manifest: TaskManifest;
  taskDir: string; // absolute path to the task directory containing manifest/spec
  manifestPath: string;
  specPath: string;
  slug: string;
};

export type NormalizedLocks = {
  reads: string[];
  writes: string[];
};

export function formatManifestIssues(issues: ZodIssue[]): string[] {
  return issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";

    if (issue.code === "invalid_type") {
      return `${location}: Expected ${issue.expected}, received ${issue.received}`;
    }
    if (issue.code === "invalid_enum_value") {
      const options = issue.options.map((o) => JSON.stringify(o)).join(", ");
      return `${location}: Expected one of ${options}, received ${JSON.stringify(issue.received)}`;
    }
    if (issue.code === "unrecognized_keys") {
      return `${location}: Unrecognized keys: ${issue.keys.join(", ")}`;
    }

    return `${location}: ${issue.message}`;
  });
}

export function validateResourceLocks(manifest: TaskManifest, resources: string[]): string[] {
  if (resources.length === 0) return [];
  const known = new Set(resources);
  const issues: string[] = [];

  for (const res of manifest.locks.reads ?? []) {
    if (!known.has(res)) {
      issues.push(`locks.reads references unknown resource "${res}"`);
    }
  }
  for (const res of manifest.locks.writes ?? []) {
    if (!known.has(res)) {
      issues.push(`locks.writes references unknown resource "${res}"`);
    }
  }

  return issues;
}

export function normalizeLocks(locks?: TaskManifest["locks"]): NormalizedLocks {
  const reads = Array.from(new Set(locks?.reads ?? [])).sort();
  const writes = Array.from(new Set(locks?.writes ?? [])).sort();
  return { reads, writes };
}

export function locksConflict(a: NormalizedLocks, b: NormalizedLocks): boolean {
  const bReads = new Set(b.reads);
  const bWrites = new Set(b.writes);

  for (const res of a.writes) {
    if (bWrites.has(res) || bReads.has(res)) {
      return true;
    }
  }
  for (const res of a.reads) {
    if (bWrites.has(res)) {
      return true;
    }
  }

  return false;
}
