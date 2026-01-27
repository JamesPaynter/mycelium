import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";

import type { ManifestEnforcementPolicy } from "../../../core/config.js";
import { JsonlLogger } from "../../../core/logger.js";
import { createPathsContext, type PathsContext } from "../../../core/paths.js";
import { StateStore } from "../../../core/state-store.js";
import { createRunState, startBatch, type RunState } from "../../../core/state.js";
import type { TaskStage } from "../../../core/task-layout.js";
import { buildTaskDirName, type TaskSpec } from "../../../core/task-manifest.js";
import type { BudgetTracker } from "../budgets/budget-tracker.js";
import type { CompliancePipeline } from "../compliance/compliance-pipeline.js";
import { createBatchEngine } from "../run/batch-engine.js";
import { createTaskEngine, type TaskRunResult } from "../run/task-engine.js";
import type { ControlPlaneRunConfig } from "../run-context.js";

import {
  buildProjectConfig,
  buildStatusSets,
  buildTaskManifest,
  buildTaskSpec,
  createBudgetTracker,
  createCompliancePipeline,
  writeTaskSpec,
} from "./batch-engine.merge-gating.builders.js";
import { FakeVcs, FakeWorkerRunner } from "./fakes.js";

// =============================================================================
// TYPES
// =============================================================================

export type BatchEngineFixture = {
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

// =============================================================================
// FIXTURES
// =============================================================================

export async function setupBatchEngineFixture(input: {
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
