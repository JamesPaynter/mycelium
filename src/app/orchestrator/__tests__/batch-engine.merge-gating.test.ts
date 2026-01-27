/**
 * BatchEngine merge gating tests.
 * Purpose: ensure temp merge + integration doctor gating controls fast-forwarding main.
 * Assumptions: fakes provide deterministic VCS and worker behavior.
 * Usage: npm test -- src/app/orchestrator/__tests__/batch-engine.merge-gating.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { describe, expect, it } from "vitest";

import {
  ProjectConfigSchema,
  type ManifestEnforcementPolicy,
  type ProjectConfig,
} from "../../../core/config.js";
import { JsonlLogger } from "../../../core/logger.js";
import type { ManifestComplianceResult } from "../../../core/manifest-compliance.js";
import { createPathsContext, type PathsContext } from "../../../core/paths.js";
import { StateStore } from "../../../core/state-store.js";
import { createRunState, startBatch, type RunState } from "../../../core/state.js";
import {
  resolveTaskArchivePath,
  resolveTaskDir,
  type TaskStage,
} from "../../../core/task-layout.js";
import { loadTaskLedger } from "../../../core/task-ledger.js";
import {
  buildTaskDirName,
  buildTaskSlug,
  type TaskManifest,
  type TaskSpec,
} from "../../../core/task-manifest.js";
import type {
  BudgetTracker,
  BudgetTrackingOutcome,
  BudgetUsageSnapshot,
} from "../budgets/budget-tracker.js";
import type { CompliancePipeline , CompliancePipelineOutcome } from "../compliance/compliance-pipeline.js";
import { createBatchEngine } from "../run/batch-engine.js";
import { createTaskEngine, type TaskRunResult } from "../run/task-engine.js";
import type { ControlPlaneRunConfig } from "../run-context.js";

import { FakeVcs, FakeWorkerRunner } from "./fakes.js";


// =============================================================================
// TESTS
// =============================================================================

describe("BatchEngine merge gating", () => {
  it("does not fast-forward when integration doctor fails", async () => {
    const fixture = await setupBatchEngineFixture({
      doctorCommand: 'node -e "process.exit(1)"',
    });

    try {
      const stopReason = await fixture.batchEngine.finalizeBatch({
        batchId: fixture.batchId,
        batchTasks: fixture.batchTasks,
        results: fixture.results,
      });

      expect(stopReason).toBe("integration_doctor_failed");
      expect(fixture.fakeVcs.tempMergeCalls).toHaveLength(1);
      expect(fixture.fakeVcs.fastForwardCalls).toHaveLength(0);
      expect(fixture.state.status).toBe("failed");
      expect(fixture.state.tasks[fixture.taskId]?.status).toBe("needs_human_review");

      const ledger = await loadTaskLedger(fixture.projectName, fixture.paths);
      expect(ledger).toBeNull();

      const activePath = resolveTaskDir({
        tasksRoot: fixture.tasksRoot,
        stage: fixture.taskStage,
        taskDirName: fixture.taskDirName,
      });
      const archivePath = resolveTaskArchivePath({
        tasksRoot: fixture.tasksRoot,
        runId: fixture.runId,
        taskDirName: fixture.taskDirName,
      });

      expect(await fse.pathExists(activePath)).toBe(true);
      expect(await fse.pathExists(archivePath)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fast-forwards and completes tasks after integration doctor passes", async () => {
    const fixture = await setupBatchEngineFixture({
      doctorCommand: 'node -e "process.exit(0)"',
    });

    try {
      const stopReason = await fixture.batchEngine.finalizeBatch({
        batchId: fixture.batchId,
        batchTasks: fixture.batchTasks,
        results: fixture.results,
      });

      expect(stopReason).toBeUndefined();
      expect(fixture.fakeVcs.tempMergeCalls).toHaveLength(1);
      expect(fixture.fakeVcs.fastForwardCalls).toHaveLength(1);
      expect(fixture.state.tasks[fixture.taskId]?.status).toBe("complete");

      const ledger = await loadTaskLedger(fixture.projectName, fixture.paths);
      expect(ledger?.tasks[fixture.taskId]?.integrationDoctorPassed).toBe(true);
      expect(ledger?.tasks[fixture.taskId]?.mergeCommit).toBe(fixture.fakeVcs.mergeCommit);

      const activePath = resolveTaskDir({
        tasksRoot: fixture.tasksRoot,
        stage: fixture.taskStage,
        taskDirName: fixture.taskDirName,
      });
      const archivePath = resolveTaskArchivePath({
        tasksRoot: fixture.tasksRoot,
        runId: fixture.runId,
        taskDirName: fixture.taskDirName,
      });

      expect(await fse.pathExists(activePath)).toBe(false);
      expect(await fse.pathExists(archivePath)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

// =============================================================================
// FIXTURES
// =============================================================================

type BatchEngineFixture = {
  batchEngine: ReturnType<typeof createBatchEngine>;
  batchId: number;
  batchTasks: TaskSpec[];
  results: TaskRunResult[];
  projectName: string;
  runId: string;
  taskId: string;
  taskDirName: string;
  taskStage: TaskStage;
  state: RunState;
  fakeVcs: FakeVcs;
  paths: PathsContext;
  tasksRoot: string;
  cleanup: () => Promise<void>;
};

async function setupBatchEngineFixture(input: {
  doctorCommand: string;
}): Promise<BatchEngineFixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-engine-"));
  const repoPath = path.join(tmpRoot, "repo");
  const tasksRoot = path.join(repoPath, "tasks");
  const projectName = "batch-engine-merge-gating";
  const runId = "run-merge-gating";
  const taskId = "001";
  const batchId = 1;

  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(tasksRoot, { recursive: true });

  const activeDir = path.join(tasksRoot, "active");
  await fs.mkdir(activeDir, { recursive: true });

  const paths = createPathsContext({ myceliumHome: path.join(tmpRoot, "mycelium-home") });
  const orchestratorLog = new JsonlLogger(path.join(tmpRoot, "orchestrator.jsonl"), { runId });

  const config = buildProjectConfig(repoPath, {
    doctor: input.doctorCommand,
    doctor_canary: {
      mode: "off",
      env_var: "ORCH_CANARY",
      warn_on_unexpected_pass: true,
    },
  });

  const manifest = buildTaskManifest(taskId, "merge gating");
  const taskDirName = buildTaskDirName(manifest);
  const taskStage: TaskStage = "active";
  const taskSpec = buildTaskSpec({ manifest, taskDirName, stage: taskStage });

  await writeTaskSpec(activeDir, manifest);

  const state = createRunState({
    runId,
    project: projectName,
    repoPath,
    mainBranch: config.main_branch,
    taskIds: [taskId],
  });
  startBatch(state, { batchId, taskIds: [taskId] });

  const fakeVcs = new FakeVcs();
  const fakeRunner = new FakeWorkerRunner();
  const stateStore = new StateStore(projectName, runId, paths);

  const controlPlaneConfig: ControlPlaneRunConfig = {
    enabled: false,
    componentResourcePrefix: "component:",
    fallbackResource: "repo",
    resourcesMode: "prefer-derived",
    scopeMode: "off",
    lockMode: "declared",
    checks: {
      mode: "off",
      commandsByComponent: {},
      maxComponentsForScoped: 0,
      fallbackCommand: undefined,
    },
    surfacePatterns: {
      contract: [],
      config: [],
      migration: [],
      "public-entrypoint": [],
    },
    surfaceLocksEnabled: false,
  };

  const taskEngine = createTaskEngine({
    projectName,
    runId,
    config,
    state,
    stateStore,
    tasksRootAbs: tasksRoot,
    repoPath,
    paths,
    workerRunner: fakeRunner,
    vcs: fakeVcs,
    orchestratorLog,
    mockLlmMode: true,
    crashAfterContainerStart: false,
    controlPlaneConfig,
    derivedScopeReports: new Map(),
    blastContext: null,
    policyDecisions: new Map(),
  });

  const results = taskEngine.buildReadyForValidationSummaries([taskSpec]);

  const budgetTracker = createBudgetTracker() as unknown as BudgetTracker;
  const compliancePipeline = createCompliancePipeline() as unknown as CompliancePipeline;
  const runMetrics = {
    scopeViolations: { warnCount: 0, blockCount: 0 },
    fallbackRepoRootCount: 0,
    blastRadius: { impactedComponentsTotal: 0, reports: 0 },
    validation: { doctorMsTotal: 0, checksetMsTotal: 0 },
  };

  const batchEngine = createBatchEngine(
    {
      projectName,
      runId,
      repoPath,
      tasksRootAbs: tasksRoot,
      paths,
      config,
      state,
      stateStore,
      orchestratorLog,
      taskEngine,
      validationPipeline: null,
      compliancePipeline,
      budgetTracker,
      runMetrics,
      recordDoctorDuration: () => undefined,
      controlPlaneConfig,
      derivedScopeReports: new Map(),
      scopeComplianceMode: "off",
      manifestPolicy: "warn" satisfies ManifestEnforcementPolicy,
      policyDecisions: new Map(),
      blastContext: null,
      doctorValidatorConfig: undefined,
      doctorValidatorEnabled: false,
      doctorCanaryConfig: { mode: "off", env_var: "ORCH_CANARY", warn_on_unexpected_pass: true },
      cleanupWorkspacesOnSuccess: false,
      cleanupContainersOnSuccess: false,
      workerRunner: fakeRunner,
      shouldSkipCleanup: () => false,
      vcs: fakeVcs,
      buildStatusSets,
    },
    { doctorValidatorLastCount: 0 },
  );

  return {
    batchEngine,
    batchId,
    batchTasks: [taskSpec],
    results,
    projectName,
    runId,
    taskId,
    taskDirName,
    taskStage,
    state,
    fakeVcs,
    paths,
    tasksRoot,
    cleanup: async () => {
      orchestratorLog.close();
      await fse.remove(tmpRoot);
    },
  };
}

function buildProjectConfig(
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

function buildTaskManifest(
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

function buildTaskSpec(input: {
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

async function writeTaskSpec(tasksRoot: string, manifest: TaskManifest): Promise<void> {
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

function buildStatusSets(state: RunState): { completed: Set<string>; failed: Set<string> } {
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

function createBudgetTracker(): Pick<BudgetTracker, "recordUsageUpdates" | "evaluateBreaches"> {
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

function createCompliancePipeline(): Pick<CompliancePipeline, "runForTask"> {
  return {
    runForTask: async (): Promise<CompliancePipelineOutcome> => ({
      effectivePolicy: "warn",
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
