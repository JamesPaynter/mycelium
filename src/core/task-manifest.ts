import { z, type RefinementCtx, type ZodIssue } from "zod";

import { normalizeTestPaths } from "./test-paths.js";
import type { TaskStage } from "./task-layout.js";
import { slugify } from "./utils.js";

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

const TddModeSchema = z.enum(["off", "strict"]);

export const TaskManifestBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    estimated_minutes: z.number().int().positive(),
    dependencies: z.array(z.string()).optional(),
    locks: LocksSchema.default({ reads: [], writes: [] }),
    files: FilesSchema.default({ reads: [], writes: [] }),
    affected_tests: z.array(z.string()).default([]),
    test_paths: z.array(z.string()).default([]),
    tdd_mode: TddModeSchema.default("off"),
    verify: VerifySchema,
  })
  .strict();

type TaskManifestBase = z.infer<typeof TaskManifestBaseSchema>;

function applyTddRequirements(manifest: TaskManifestBase, ctx: RefinementCtx): void {
  if (manifest.tdd_mode === "strict" && !manifest.verify.fast?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["verify", "fast"],
      message: "verify.fast is required when tdd_mode=strict",
    });
  }
}

export const TaskManifestSchema = TaskManifestBaseSchema.superRefine(applyTddRequirements);

export const TaskManifestWithSpecSchema = TaskManifestBaseSchema.extend({
  spec: z.string().min(1),
}).superRefine(applyTddRequirements);

export type TaskManifest = z.infer<typeof TaskManifestSchema>;

export type TaskSpec = {
  manifest: TaskManifest;
  taskDirName: string;
  stage: TaskStage;
  slug: string;
};

export type TaskWithSpec = z.infer<typeof TaskManifestWithSpecSchema>;

export type NormalizedLocks = {
  reads: string[];
  writes: string[];
};

export type NormalizedFiles = {
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
  return {
    reads: normalizeStringList(locks?.reads),
    writes: normalizeStringList(locks?.writes),
  };
}

export function normalizeFiles(files?: TaskManifest["files"]): NormalizedFiles {
  return {
    reads: normalizeStringList(files?.reads),
    writes: normalizeStringList(files?.writes),
  };
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

export function normalizeTaskId(id: string): string {
  return id.trim();
}

export function normalizeTaskName(name: string): string {
  return name.trim();
}

export function buildTaskSlug(name: string): string {
  const slug = slugify(normalizeTaskName(name));
  return slug.length > 0 ? slug : "task";
}

export function buildTaskDirName(task: Pick<TaskManifest, "id" | "name">): string {
  return `${normalizeTaskId(task.id)}-${buildTaskSlug(task.name)}`;
}

export function normalizeTaskManifest(manifest: TaskManifest): TaskManifest {
  const dependencies = normalizeStringList(manifest.dependencies);
  const locks = normalizeLocks(manifest.locks);
  const files = normalizeFiles(manifest.files);
  const affectedTests = normalizeStringList(manifest.affected_tests);
  const testPaths = normalizeTestPaths(manifest.test_paths);
  const tddMode = manifest.tdd_mode ?? "off";

  const doctor = manifest.verify.doctor.trim();
  const fast = manifest.verify.fast?.trim();

  return {
    ...manifest,
    id: normalizeTaskId(manifest.id),
    name: normalizeTaskName(manifest.name),
    dependencies: dependencies.length > 0 ? dependencies : undefined,
    locks,
    files,
    affected_tests: affectedTests,
    test_paths: testPaths,
    tdd_mode: tddMode,
    verify: fast ? { doctor, fast } : { doctor },
  };
}

function normalizeStringList(values?: string[]): string[] {
  return Array.from(
    new Set((values ?? []).map((v) => v.trim()).filter((v) => v.length > 0)),
  ).sort();
}
