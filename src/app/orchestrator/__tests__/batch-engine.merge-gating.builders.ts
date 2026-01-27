import fs from "node:fs/promises";
import path from "node:path";

import {
  ProjectConfigSchema,
  type ManifestEnforcementPolicy,
  type ProjectConfig,
} from "../../../core/config.js";
import type { ManifestComplianceResult } from "../../../core/manifest-compliance.js";
import type { RunState } from "../../../core/state.js";
import type { TaskStage } from "../../../core/task-layout.js";
import { buildTaskDirName, buildTaskSlug, type TaskManifest, type TaskSpec } from "../../../core/task-manifest.js";
import type {
  BudgetTracker,
  BudgetTrackingOutcome,
  BudgetUsageSnapshot,
} from "../budgets/budget-tracker.js";
import type {
  CompliancePipeline,
  CompliancePipelineOutcome,
} from "../compliance/compliance-pipeline.js";

// =============================================================================
// CONFIG + TASK BUILDERS
// =============================================================================

export function buildProjectConfig(
  repoPath: string,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return ProjectConfigSchema.parse({
    repo_path: repoPath,
    main_branch: "main",
    tasks_dir: "tasks",
    doctor: "true",
    resources: [{ name: "repo", paths: ["**/*"] }],
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock" },
    ...overrides,
  });
}

export function buildTaskManifest(
  id: string,
  name: string,
  overrides: Partial<TaskManifest> = {},
): TaskManifest {
  const base: TaskManifest = {
    id,
    name,
    description: `Task ${id} for batch-engine tests.`,
    estimated_minutes: 5,
    dependencies: [],
    locks: { reads: [], writes: ["repo"] },
    files: { reads: [], writes: [`src/${id}.txt`] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "true" },
  };

  return {
    ...base,
    ...overrides,
    dependencies: overrides.dependencies ?? base.dependencies,
    locks: { ...base.locks, ...(overrides.locks ?? {}) },
    files: { ...base.files, ...(overrides.files ?? {}) },
    verify: { ...base.verify, ...(overrides.verify ?? {}) },
  };
}

export function buildTaskSpec(input: {
  manifest: TaskManifest;
  taskDirName: string;
  stage: TaskStage;
}): TaskSpec {
  return {
    manifest: input.manifest,
    taskDirName: input.taskDirName,
    stage: input.stage,
    slug: buildTaskSlug(input.manifest.name),
  };
}

export async function writeTaskSpec(tasksRoot: string, manifest: TaskManifest): Promise<void> {
  const taskDirName = buildTaskDirName({ id: manifest.id, name: manifest.name });
  const taskDir = path.join(tasksRoot, taskDirName);
  await fs.mkdir(taskDir, { recursive: true });

  await fs.writeFile(
    path.join(taskDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(taskDir, "spec.md"), `# ${manifest.name}\n`, "utf8");
}

export function buildStatusSets(
  state: RunState,
): { completed: Set<string>; failed: Set<string> } {
  const blockedStatuses = new Set([
    "failed",
    "needs_human_review",
    "needs_rescope",
    "rescope_required",
  ]);
  const completed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => s.status === "complete" || s.status === "validated" || s.status === "skipped")
      .map(([id]) => id),
  );
  const failed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => blockedStatuses.has(s.status))
      .map(([id]) => id),
  );
  return { completed, failed };
}

// =============================================================================
// BUDGET + COMPLIANCE FAKES
// =============================================================================

export function createBudgetTracker(): Pick<BudgetTracker, "recordUsageUpdates" | "evaluateBreaches"> {
  return {
    recordUsageUpdates: (): BudgetUsageSnapshot => ({
      runUsageBefore: { tokensUsed: 0, estimatedCost: 0 },
      runUsageAfter: { tokensUsed: 0, estimatedCost: 0 },
      usageUpdates: [],
    }),
    evaluateBreaches: ({
      snapshot,
    }: {
      snapshot: BudgetUsageSnapshot;
    }): BudgetTrackingOutcome => ({
      ...snapshot,
      breaches: [],
    }),
  };
}

export function createCompliancePipeline(): Pick<CompliancePipeline, "runForTask"> {
  return {
    runForTask: async (): Promise<CompliancePipelineOutcome> => ({
      effectivePolicy: "warn" satisfies ManifestEnforcementPolicy,
      reportPath: "compliance.json",
      compliance: buildComplianceResult(),
      scopeViolations: { warnCount: 0, blockCount: 0 },
      rescope: { status: "skipped", reason: "disabled in tests" },
    }),
  };
}

function buildComplianceResult(): ManifestComplianceResult {
  return {
    policy: "warn",
    status: "skipped",
    changedFiles: [],
    violations: [],
    report: {
      task_id: "test",
      task_name: "test",
      policy: "warn",
      status: "skipped",
      changed_files: [],
      violations: [],
      manifest: {
        locks: { reads: [], writes: [] },
        files: { reads: [], writes: [] },
      },
    },
  };
}
