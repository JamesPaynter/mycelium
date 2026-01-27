import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { z } from "zod";

import { LlmError, type LlmCompletionResult } from "../llm/client.js";

import type { ResourceConfig } from "./config.js";
import {
  TaskManifestWithSpecSchema,
  formatManifestIssues,
  normalizeTaskManifest,
  type TaskWithSpec,
  validateResourceLocks,
} from "./task-manifest.js";
import { normalizeTestPaths } from "./test-paths.js";
import { readTextFile } from "./utils.js";

// =============================================================================
// SCHEMAS
// =============================================================================

export const PlannerOutputJsonSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          estimated_minutes: { type: "integer" },
          dependencies: { type: "array", items: { type: "string" } },
          locks: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          files: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          test_paths: { type: "array", items: { type: "string" } },
          tdd_mode: { type: "string", enum: ["off", "strict"] },
          affected_tests: { type: "array", items: { type: "string" } },
          verify: {
            type: "object",
            properties: {
              doctor: { type: "string" },
              fast: { type: "string" },
              lint: { type: "string" },
            },
            required: ["doctor"],
            additionalProperties: false,
          },
          spec: { type: "string" },
        },
        required: [
          "id",
          "name",
          "description",
          "estimated_minutes",
          "dependencies",
          "locks",
          "files",
          "test_paths",
          "tdd_mode",
          "affected_tests",
          "verify",
          "spec",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
} as const;

const PlannerResponseSchema = z.object({
  tasks: z.array(TaskManifestWithSpecSchema).min(1, "Planner must return at least one task."),
});

export type PlannerOutput = z.infer<typeof PlannerResponseSchema>;

// =============================================================================
// PARSING
// =============================================================================

export function parsePlannerOutput(
  completion: LlmCompletionResult<PlannerOutput>,
  resources: string[],
): TaskWithSpec[] {
  const raw = completion.parsed ?? parseJson(completion.text);
  const parsed = PlannerResponseSchema.safeParse(raw);

  if (!parsed.success) {
    const detail = formatManifestIssues(parsed.error.issues)
      .map((i) => `- ${i}`)
      .join("\n");
    throw new Error(`Planner output failed schema validation:\n${detail}`);
  }

  const normalized = parsed.data.tasks.map((task) => {
    const { spec, ...manifestFields } = task;
    const manifest = normalizeTaskManifest(manifestFields);
    return { ...manifest, spec: spec.trim() };
  });

  const validationIssues = validatePlannerTasks(normalized, resources);
  if (validationIssues.length > 0) {
    const detail = validationIssues.map((i) => `- ${i}`).join("\n");
    throw new Error(`Planner output failed validation:\n${detail}`);
  }

  return normalized;
}

function validatePlannerTasks(tasks: TaskWithSpec[], resources: string[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const allIds = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    const taskIssues: string[] = [];

    if (seenIds.has(task.id)) {
      taskIssues.push(`duplicate id "${task.id}"`);
    } else {
      seenIds.add(task.id);
    }

    if (!isKebabCase(task.name)) {
      taskIssues.push(`name must be kebab-case (got "${task.name}")`);
    }

    const lockIssues = validateResourceLocks(task, resources);
    if (lockIssues.length > 0) taskIssues.push(...lockIssues);

    if (!task.verify.doctor.trim()) {
      taskIssues.push("verify.doctor is required");
    }
    if (task.tdd_mode === "strict") {
      const testPaths = normalizeTestPaths(task.test_paths);
      if (testPaths.length === 0) {
        taskIssues.push("test_paths must be provided when tdd_mode is strict");
      }
      if (task.affected_tests.length === 0) {
        taskIssues.push("affected_tests must be provided when tdd_mode is strict");
      }
      if (!task.verify.fast?.trim()) {
        taskIssues.push("verify.fast is required when tdd_mode is strict");
      }
    }

    const deps = task.dependencies ?? [];
    const missingDeps = deps.filter((dep) => !allIds.has(dep));
    if (missingDeps.length > 0) {
      taskIssues.push(`dependencies reference unknown ids: ${missingDeps.join(", ")}`);
    }
    if (deps.includes(task.id)) {
      taskIssues.push("dependencies cannot include the task itself");
    }

    if (taskIssues.length > 0) {
      issues.push(`Task ${task.id}: ${taskIssues.join("; ")}`);
    }
  }

  return issues;
}

function isKebabCase(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

// =============================================================================
// FORMATTING
// =============================================================================

export function formatResources(resources: ResourceConfig[]): string {
  return resources
    .map((resource) => {
      const desc = resource.description ? `: ${resource.description}` : "";
      return `- **${resource.name}**${desc}\n  - Paths: ${resource.paths.join(", ")}`;
    })
    .join("\n");
}

// =============================================================================
// INPUT LOADING
// =============================================================================

export async function readImplementationPlan(inputPath: string): Promise<string> {
  const exists = await fse.pathExists(inputPath);
  if (!exists) {
    throw new Error(`Implementation plan not found at ${inputPath}`);
  }
  return readTextFile(inputPath);
}

export async function readCodebaseTree(repoPath: string): Promise<string> {
  try {
    const tree = await execa("git", ["ls-files"], { cwd: repoPath, stdio: "pipe" });
    return tree.stdout.trim();
  } catch (err) {
    throw new Error(`Failed to read git tree for ${repoPath}: ${formatError(err)}`);
  }
}

// =============================================================================
// UTILS
// =============================================================================

export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new LlmError("Planner returned non-JSON output.", err);
  }
}

export function secondsToMs(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return value * 1000;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
