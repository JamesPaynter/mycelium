import { z } from "zod";

export const LocksSchema = z.object({
  reads: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([])
});

export const FilesSchema = z.object({
  reads: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([])
});

export const VerifySchema = z.object({
  doctor: z.string().min(1),
  fast: z.string().optional()
});

export const TaskManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  estimated_minutes: z.number().int().positive().optional(),
  dependencies: z.array(z.string()).optional(),
  locks: LocksSchema.default({ reads: [], writes: [] }),
  files: FilesSchema.default({ reads: [], writes: [] }),
  affected_tests: z.array(z.string()).default([]),
  verify: VerifySchema.optional()
});

export type TaskManifest = z.infer<typeof TaskManifestSchema>;

export type TaskSpec = {
  manifest: TaskManifest;
  taskDir: string; // absolute path to the task directory containing manifest/spec
  manifestPath: string;
  specPath: string;
  slug: string;
};
