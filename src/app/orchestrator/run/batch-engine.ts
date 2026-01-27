/**
 * BatchEngine handles batch-level orchestration logic.
 * Purpose: finalize batches with validation, merges, ledger updates, and cleanup.
 * Assumptions: run engine owns run state + store, passed in by reference.
 * Usage: const batchEngine = createBatchEngine(ctx, initial); await batchEngine.finalizeBatch(...).
 */

import { execaCommand } from "execa";

import {
  buildBlastRadiusReport,
  type ControlPlaneBlastRadiusReport,
} from "../../../control-plane/integration/blast-radius.js";
import {
  buildTaskChangeManifest,
  type TaskChangeManifest,
} from "../../../control-plane/integration/change-manifest.js";
import type { DerivedScopeReport } from "../../../control-plane/integration/derived-scope.js";
import { evaluateControlGraphScope } from "../../../control-plane/integration/scope-enforcement.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import type { PolicyDecision, SurfacePatternSet } from "../../../control-plane/policy/types.js";
import type {
  ControlPlaneScopeMode,
  ManifestEnforcementPolicy,
  ProjectConfig,
} from "../../../core/config.js";
import type { JsonObject, JsonlLogger } from "../../../core/logger.js";
import { logOrchestratorEvent, logTaskReset } from "../../../core/logger.js";
import { computeRescopeFromComponentScope } from "../../../core/manifest-rescope.js";
import type { PathsContext } from "../../../core/paths.js";
import { taskBlastReportPath, taskChangeManifestPath } from "../../../core/paths.js";
import type { StateStore } from "../../../core/state-store.js";
import {
  completeBatch,
  markTaskComplete,
  markTaskFailed,
  markTaskNeedsHumanReview,
  markTaskRescopeRequired,
  markTaskValidated,
  resetTaskToPending,
  type RunState,
  type ValidatorResult,
} from "../../../core/state.js";
import {
  resolveTaskManifestPath,
  resolveTaskSpecPath,
  moveTaskDir,
} from "../../../core/task-layout.js";
import { computeTaskFingerprint, upsertLedgerEntry } from "../../../core/task-ledger.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import { isoNow, writeJsonFile } from "../../../core/utils.js";
import { removeTaskWorkspace } from "../../../core/workspaces.js";
import type { FastForwardResult, MergeConflict, TempMergeResult } from "../../../git/merge.js";
import type { DoctorCanaryResult } from "../../../validators/doctor-validator.js";
import type { BudgetTracker } from "../budgets/budget-tracker.js";
import type { CompliancePipeline } from "../compliance/compliance-pipeline.js";
import { formatErrorMessage } from "../helpers/errors.js";
import {
  buildDoctorCanarySummary,
  formatDoctorCanaryEnvVar,
  limitText,
} from "../helpers/format.js";
import type { ControlPlaneRunConfig } from "../run-context.js";
import type { DoctorValidationOutcome, ValidationOutcome } from "../validation/types.js";
import type { ValidationPipeline } from "../validation/validation-pipeline.js";
import type { Vcs } from "../vcs/vcs.js";
import type { WorkerRunner } from "../workers/worker-runner.js";

import type { RunMetrics } from "./run-engine.js";
import type { TaskEngine, TaskRunResult, TaskSuccessResult } from "./task-engine.js";


// =============================================================================
// TYPES
// =============================================================================

export type BatchStopReason = "integration_doctor_failed" | "budget_block";

export type BatchEngineContext = {
  projectName: string;
  runId: string;
  repoPath: string;
  tasksRootAbs: string;
  paths?: PathsContext;
  config: ProjectConfig;
  state: RunState;
  stateStore: StateStore;
  orchestratorLog: JsonlLogger;
  taskEngine: TaskEngine;
  validationPipeline: ValidationPipeline | null;
  compliancePipeline: CompliancePipeline;
  budgetTracker: BudgetTracker;
  runMetrics: RunMetrics;
  recordDoctorDuration: (durationMs: number) => void;
  controlPlaneConfig: ControlPlaneRunConfig;
  derivedScopeReports: Map<string, DerivedScopeReport>;
  scopeComplianceMode: ControlPlaneScopeMode;
  manifestPolicy: ManifestEnforcementPolicy;
  policyDecisions: Map<string, PolicyDecision>;
  blastContext: BlastRadiusContext | null;
  doctorValidatorConfig: ProjectConfig["doctor_validator"] | undefined;
  doctorValidatorEnabled: boolean;
  doctorCanaryConfig: ProjectConfig["doctor_canary"];
  cleanupWorkspacesOnSuccess: boolean;
  cleanupContainersOnSuccess: boolean;
  workerRunner: WorkerRunner;
  shouldSkipCleanup: () => boolean;
  vcs: Vcs;
  buildStatusSets: (state: RunState) => { completed: Set<string>; failed: Set<string> };
};

export type BatchEngine = {
  finalizeBatch(params: {
    batchId: number;
    batchTasks: TaskSpec[];
    results: TaskRunResult[];
  }): Promise<BatchStopReason | undefined>;
};

type IntegrationDoctorFailureDetail = {
  exitCode: number;
  output: string;
};

type MergeOutcome = {
  mergedTasks: TaskSuccessResult[];
  appliedTasks: TaskSuccessResult[];
  mergeApplied: boolean;
  batchMergeCommit?: string;
  integrationDoctorPassed?: boolean;
  stopReason?: BatchStopReason;
  doctorCanaryResult?: DoctorCanaryResult;
  integrationDoctorFailureDetail: IntegrationDoctorFailureDetail | null;
  stateUpdated: boolean;
};

// =============================================================================
// ENGINE
// =============================================================================

export function createBatchEngine(
  context: BatchEngineContext,
  initial: {
    doctorValidatorLastCount: number;
    lastIntegrationDoctorCanary?: DoctorCanaryResult;
  },
): BatchEngine {
  const doctorValidatorRunEvery = context.doctorValidatorConfig?.run_every_n_tasks;
  let doctorValidatorLastCount = initial.doctorValidatorLastCount;
  let lastIntegrationDoctorOutput: string | undefined;
  let lastIntegrationDoctorExitCode: number | undefined;
  let lastIntegrationDoctorCanary: DoctorCanaryResult | undefined =
    initial.lastIntegrationDoctorCanary;

  const applyValidationOutcome = (
    taskId: string,
    outcome: ValidationOutcome,
    blockedTasks: Set<string>,
  ): void => {
    const blockedByValidator = new Map(outcome.blocked.map((block) => [block.validator, block]));

    for (const result of outcome.results) {
      setValidatorResult(context.state, taskId, {
        validator: result.validator,
        status: result.status,
        mode: result.mode,
        summary: result.summary ?? undefined,
        report_path: result.reportPath ?? undefined,
        trigger: result.trigger,
      });

      const blocked = blockedByValidator.get(result.validator);
      if (!blocked) continue;

      blockedTasks.add(taskId);
      markTaskNeedsHumanReview(context.state, taskId, {
        validator: blocked.validator,
        reason: blocked.reason,
        summary: blocked.summary ?? undefined,
        reportPath: blocked.reportPath ?? undefined,
      });

      const payload: JsonObject = {
        validator: blocked.validator,
        taskId,
        mode: blocked.mode,
        status: blocked.status,
      };
      if (blocked.validator === "doctor") {
        payload.trigger = blocked.trigger ?? "unknown";
      }
      logOrchestratorEvent(context.orchestratorLog, "validator.block", payload);
    }
  };

  const applyDoctorOutcome = (
    taskId: string,
    outcome: DoctorValidationOutcome,
    blockedTasks: Set<string>,
  ): void => {
    applyValidationOutcome(
      taskId,
      {
        taskId,
        results: [outcome.result],
        blocked: outcome.blocked ? [outcome.blocked] : [],
      },
      blockedTasks,
    );
  };

  const applyControlGraphScopeEnforcement = async (input: {
    task: TaskSpec;
    taskId: string;
    changeManifest: TaskChangeManifest | null;
  }): Promise<void> => {
    if (!context.controlPlaneConfig.enabled) {
      return;
    }

    const taskId = input.taskId;
    const taskState = context.state.tasks[taskId];
    if (!taskState || taskState.status !== "running") {
      return;
    }

    if (!input.changeManifest) {
      const reason = "Control graph scope enforcement failed: change manifest missing.";
      markTaskNeedsHumanReview(context.state, taskId, {
        validator: "doctor",
        reason,
      });
      logOrchestratorEvent(context.orchestratorLog, "task.rescope.failed", {
        taskId,
        reason,
      });
      return;
    }

    if (input.changeManifest.changed_files.length === 0) {
      return;
    }

    const changeManifestPath = taskChangeManifestPath(context.repoPath, context.runId, taskId);
    const evaluation = evaluateControlGraphScope({
      manifest: input.task.manifest,
      derivedScopeReport: context.derivedScopeReports.get(taskId) ?? null,
      changeManifest: input.changeManifest,
      componentResourcePrefix: context.controlPlaneConfig.componentResourcePrefix,
      model: context.blastContext?.model ?? null,
    });

    if (evaluation.status === "pass") {
      return;
    }

    if (evaluation.status === "unmapped") {
      const reason = `Control graph scope enforcement failed: ${evaluation.reason}`;
      markTaskNeedsHumanReview(context.state, taskId, {
        validator: "doctor",
        reason,
        summary: evaluation.reason,
        reportPath: changeManifestPath,
      });
      logOrchestratorEvent(context.orchestratorLog, "task.rescope.failed", {
        taskId,
        reason,
        report_path: changeManifestPath,
        unmapped_files: evaluation.unmappedFiles,
        missing_components: evaluation.missingComponents,
      });
      return;
    }

    const rescopeReason = `Rescope required: ${evaluation.reason}`;
    const rescope = computeRescopeFromComponentScope({
      manifest: input.task.manifest,
      componentResourcePrefix: context.controlPlaneConfig.componentResourcePrefix,
      missingComponents: evaluation.missingComponents,
      changedFiles: evaluation.changedFiles,
    });

    if (rescope.status !== "updated") {
      const reason = `Control graph scope enforcement failed: ${rescope.reason}`;
      markTaskNeedsHumanReview(context.state, taskId, {
        validator: "doctor",
        reason,
        summary: evaluation.reason,
        reportPath: changeManifestPath,
      });
      logOrchestratorEvent(context.orchestratorLog, "task.rescope.failed", {
        taskId,
        reason,
        report_path: changeManifestPath,
        missing_components: evaluation.missingComponents,
      });
      return;
    }

    markTaskRescopeRequired(context.state, taskId, rescopeReason);
    logOrchestratorEvent(context.orchestratorLog, "task.rescope.start", {
      taskId,
      reason: rescopeReason,
      report_path: changeManifestPath,
      missing_components: evaluation.missingComponents,
    });

    const manifestPath = resolveTaskManifestPath({
      tasksRoot: context.tasksRootAbs,
      stage: input.task.stage,
      taskDirName: input.task.taskDirName,
    });
    await writeJsonFile(manifestPath, rescope.manifest);
    input.task.manifest = rescope.manifest;

    const resetReason = `Rescoped manifest (control graph): +${rescope.addedLocks.length} locks, +${rescope.addedFiles.length} files`;
    resetTaskToPending(context.state, taskId, resetReason);
    logOrchestratorEvent(context.orchestratorLog, "task.rescope.updated", {
      taskId,
      added_locks: rescope.addedLocks,
      added_files: rescope.addedFiles,
      manifest_path: manifestPath,
      report_path: changeManifestPath,
      reason: resetReason,
    });
  };

  const cleanupSuccessfulBatchArtifacts = async (args: {
    batchStatus: "complete" | "failed";
    integrationDoctorPassed?: boolean;
    successfulTasks: TaskSuccessResult[];
  }): Promise<void> => {
    if (!context.cleanupWorkspacesOnSuccess && !context.cleanupContainersOnSuccess) return;
    if (args.batchStatus !== "complete") return;
    if (args.integrationDoctorPassed !== true) return;
    if (args.successfulTasks.length === 0) return;

    // Skip cleanup when a stop signal is pending so resuming keeps the workspace state.
    if (context.shouldSkipCleanup()) return;

    if (context.cleanupContainersOnSuccess) {
      for (const task of args.successfulTasks) {
        await context.workerRunner.cleanupTask({
          taskId: task.taskId,
          containerIdHint: context.state.tasks[task.taskId]?.container_id,
          orchestratorLogger: context.orchestratorLog,
        });
      }
    }

    if (context.cleanupWorkspacesOnSuccess) {
      for (const task of args.successfulTasks) {
        try {
          await removeTaskWorkspace(context.projectName, context.runId, task.taskId, context.paths);
          logOrchestratorEvent(context.orchestratorLog, "workspace.cleanup", {
            taskId: task.taskId,
            workspace: task.workspace,
          });
        } catch (error) {
          logOrchestratorEvent(context.orchestratorLog, "workspace.cleanup.error", {
            taskId: task.taskId,
            workspace: task.workspace,
            message: formatErrorMessage(error),
          });
        }
      }
    }
  };

  const refreshStatusSets = async (): Promise<{ completed: Set<string>; failed: Set<string> }> => {
    await context.stateStore.save(context.state);
    return context.buildStatusSets(context.state);
  };

  const rebuildStatusSets = (): { completed: Set<string>; failed: Set<string> } => {
    return context.buildStatusSets(context.state);
  };

  const handleFailedResult = (result: TaskRunResult): void => {
    if (result.resetToPending) {
      const reason = result.errorMessage ?? "Task reset to pending";
      resetTaskToPending(context.state, result.taskId, reason);
      logTaskReset(context.orchestratorLog, result.taskId, reason);
      return;
    }

    const errorMessage = result.errorMessage ?? "Task worker exited with a non-zero status";
    markTaskFailed(context.state, result.taskId, errorMessage);
    logOrchestratorEvent(context.orchestratorLog, "task.failed", {
      taskId: result.taskId,
      attempts: context.state.tasks[result.taskId].attempts,
      message: errorMessage,
    });
  };

  const handleMissingTaskSpec = (result: TaskRunResult): void => {
    const message = "Task spec missing during finalizeBatch";
    markTaskFailed(context.state, result.taskId, message);
    logOrchestratorEvent(context.orchestratorLog, "task.failed", {
      taskId: result.taskId,
      attempts: context.state.tasks[result.taskId].attempts,
      message,
    });
  };

  const maybeEmitChangeManifest = async (input: {
    result: TaskRunResult;
    taskSpec: TaskSpec | null;
    changeManifestBaseSha: string;
  }): Promise<TaskChangeManifest | null> => {
    if (!input.result.success || !input.taskSpec) {
      return null;
    }

    return await emitChangeManifestReport({
      repoPath: context.repoPath,
      runId: context.runId,
      task: input.taskSpec,
      workspacePath: input.result.workspace,
      baseSha: input.changeManifestBaseSha,
      model: context.blastContext?.model ?? null,
      surfacePatterns: context.controlPlaneConfig.surfacePatterns,
      vcs: context.vcs,
      orchestratorLog: context.orchestratorLog,
    });
  };

  const maybeEmitBlastRadius = async (input: {
    result: TaskRunResult;
    taskSpec: TaskSpec | null;
    changeManifest: TaskChangeManifest | null;
  }): Promise<void> => {
    if (!context.blastContext || !input.taskSpec) {
      return;
    }

    try {
      const changedFiles =
        input.changeManifest?.changed_files ??
        (await context.vcs.listChangedFiles(input.result.workspace, context.blastContext.baseSha));
      const report = await emitBlastRadiusReport({
        repoPath: context.repoPath,
        runId: context.runId,
        task: input.taskSpec,
        changedFiles,
        blastContext: context.blastContext,
        orchestratorLog: context.orchestratorLog,
      });
      if (report) {
        recordBlastRadius(context.runMetrics, report);
      }
    } catch (error) {
      logOrchestratorEvent(context.orchestratorLog, "task.blast_radius.error", {
        taskId: input.result.taskId,
        task_slug: input.taskSpec.slug,
        message: formatErrorMessage(error),
      });
    }
  };

  const processTaskResults = async (input: {
    taskSpecsById: Map<string, TaskSpec>;
    results: TaskRunResult[];
    changeManifestBaseSha: string;
  }): Promise<void> => {
    for (const result of input.results) {
      const taskSpec = input.taskSpecsById.get(result.taskId) ?? null;

      const changeManifest = await maybeEmitChangeManifest({
        result,
        taskSpec,
        changeManifestBaseSha: input.changeManifestBaseSha,
      });

      await maybeEmitBlastRadius({ result, taskSpec, changeManifest });

      if (!result.success) {
        handleFailedResult(result);
        continue;
      }

      if (!taskSpec) {
        handleMissingTaskSpec(result);
        continue;
      }

      const policyDecision = context.policyDecisions.get(result.taskId);
      const complianceOutcome = await context.compliancePipeline.runForTask({
        task: taskSpec,
        taskResult: {
          taskId: result.taskId,
          taskSlug: result.taskSlug,
          workspacePath: result.workspace,
        },
        state: context.state,
        scopeMode: context.scopeComplianceMode,
        manifestPolicy: context.manifestPolicy,
        policyTier: policyDecision?.tier,
      });

      context.runMetrics.scopeViolations.warnCount += complianceOutcome.scopeViolations.warnCount;
      context.runMetrics.scopeViolations.blockCount += complianceOutcome.scopeViolations.blockCount;

      await applyControlGraphScopeEnforcement({
        task: taskSpec,
        taskId: result.taskId,
        changeManifest,
      });
    }
  };

  const runValidationPhase = async (input: {
    batchTasks: TaskSpec[];
    taskSpecsById: Map<string, TaskSpec>;
    blockedTasks: Set<string>;
  }): Promise<void> => {
    const readyForValidation = context.taskEngine.buildReadyForValidationSummaries(
      input.batchTasks,
    );

    if (context.validationPipeline) {
      for (const r of readyForValidation) {
        const taskSpec = input.taskSpecsById.get(r.taskId);
        if (!taskSpec) continue;

        const outcome = await context.validationPipeline.runForTask({
          task: taskSpec,
          workspacePath: r.workspace,
          logsDir: r.logsDir,
        });

        applyValidationOutcome(r.taskId, outcome, input.blockedTasks);
      }
    }

    const validatedTaskIds = readyForValidation
      .map((task) => task.taskId)
      .filter((taskId) => !input.blockedTasks.has(taskId));
    for (const taskId of validatedTaskIds) {
      markTaskValidated(context.state, taskId);
    }
  };

  const runDoctorCadenceValidation = async (input: {
    batchTasks: TaskSpec[];
    blockedTasks: Set<string>;
    completed: Set<string>;
    failed: Set<string>;
    stopReason: BatchStopReason | undefined;
  }): Promise<void> => {
    if (!context.doctorValidatorEnabled || !context.doctorValidatorConfig) {
      return;
    }

    const finishedCount = input.completed.size + input.failed.size;
    const shouldRunDoctorValidatorCadence =
      doctorValidatorRunEvery !== undefined &&
      finishedCount - doctorValidatorLastCount >= doctorValidatorRunEvery;

    if (!shouldRunDoctorValidatorCadence || input.stopReason) {
      return;
    }

    const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
      doctorCommand: context.config.doctor,
      doctorCanary: lastIntegrationDoctorCanary,
      trigger: "cadence",
      triggerNotes: `Cadence reached after ${finishedCount} tasks (interval ${doctorValidatorRunEvery})`,
    });
    doctorValidatorLastCount = finishedCount;

    if (doctorOutcome) {
      const recipients = context.taskEngine.buildValidatedTaskSummaries(input.batchTasks);
      for (const r of recipients) {
        applyDoctorOutcome(r.taskId, doctorOutcome, input.blockedTasks);
      }
    }
  };

  const runIntegrationDoctor = async (batchId: number): Promise<{
    doctorOk: boolean;
    exitCode: number;
    output: string;
  }> => {
    logOrchestratorEvent(context.orchestratorLog, "doctor.integration.start", {
      batch_id: batchId,
      command: context.config.doctor,
    });
    const doctorIntegrationStartedAt = Date.now();
    const doctorRes = await execaCommand(context.config.doctor, {
      cwd: context.repoPath,
      shell: true,
      reject: false,
      timeout: context.config.doctor_timeout ? context.config.doctor_timeout * 1000 : undefined,
    });
    context.recordDoctorDuration(Date.now() - doctorIntegrationStartedAt);
    lastIntegrationDoctorOutput = `${doctorRes.stdout}\n${doctorRes.stderr}`.trim();
    const doctorExitCode = doctorRes.exitCode ?? -1;
    lastIntegrationDoctorExitCode = doctorExitCode;
    const doctorOk = doctorExitCode === 0;
    logOrchestratorEvent(
      context.orchestratorLog,
      doctorOk ? "doctor.integration.pass" : "doctor.integration.fail",
      {
        batch_id: batchId,
        exit_code: doctorExitCode,
      },
    );

    return {
      doctorOk,
      exitCode: doctorExitCode,
      output: lastIntegrationDoctorOutput ?? "",
    };
  };

  const resolveDoctorCanaryResult = async (input: {
    batchId: number;
    doctorOk: boolean;
  }): Promise<DoctorCanaryResult | undefined> => {
    let doctorCanaryResult: DoctorCanaryResult | undefined;

    if (input.doctorOk) {
      if (context.doctorCanaryConfig.mode === "off") {
        doctorCanaryResult = { status: "skipped", reason: "Disabled by config" };
        logOrchestratorEvent(context.orchestratorLog, "doctor.canary.skipped", {
          batch_id: input.batchId,
          payload: {
            reason: "disabled_by_config",
            message: "Doctor canary disabled via doctor_canary.mode=off.",
          },
        });
      } else {
        logOrchestratorEvent(context.orchestratorLog, "doctor.canary.start", {
          batch_id: input.batchId,
          env_var: context.doctorCanaryConfig.env_var,
        });
        const doctorCanaryStartedAt = Date.now();
        doctorCanaryResult = await runDoctorCanary({
          command: context.config.doctor,
          cwd: context.repoPath,
          timeoutSeconds: context.config.doctor_timeout,
          envVar: context.doctorCanaryConfig.env_var,
        });
        context.recordDoctorDuration(Date.now() - doctorCanaryStartedAt);

        if (doctorCanaryResult.status === "unexpected_pass") {
          const envLabel = formatDoctorCanaryEnvVar(doctorCanaryResult.envVar);
          const severity = context.doctorCanaryConfig.warn_on_unexpected_pass ? "warn" : "error";
          logOrchestratorEvent(context.orchestratorLog, "doctor.canary.unexpected_pass", {
            batch_id: input.batchId,
            payload: {
              exit_code: doctorCanaryResult.exitCode,
              env_var: doctorCanaryResult.envVar,
              severity,
              message: `Doctor did not fail when ${envLabel} (expected non-zero exit).`,
              recommendation: `Wrap your doctor in a script that exits non-zero when ${envLabel} is set (see README).`,
              output_preview: doctorCanaryResult.output.slice(0, 500),
            },
          });
        } else if (doctorCanaryResult.status === "expected_fail") {
          logOrchestratorEvent(context.orchestratorLog, "doctor.canary.expected_fail", {
            batch_id: input.batchId,
            payload: {
              exit_code: doctorCanaryResult.exitCode,
              env_var: doctorCanaryResult.envVar,
              output_preview: doctorCanaryResult.output.slice(0, 500),
            },
          });
        }
      }
    } else {
      doctorCanaryResult = { status: "skipped", reason: "Integration doctor failed" };
      logOrchestratorEvent(context.orchestratorLog, "doctor.canary.skipped", {
        batch_id: input.batchId,
        payload: {
          reason: "integration_doctor_failed",
          message: "Skipping canary because integration doctor failed.",
        },
      });
    }

    lastIntegrationDoctorCanary = doctorCanaryResult;
    return doctorCanaryResult;
  };

  const applyMergeConflicts = async (input: {
    batchId: number;
    conflicts: MergeConflict[];
  }): Promise<boolean> => {
    if (input.conflicts.length === 0) return false;

    for (const conflict of input.conflicts) {
      const reason = "merge conflict";
      resetTaskToPending(context.state, conflict.branch.taskId, reason);
      logTaskReset(context.orchestratorLog, conflict.branch.taskId, reason);
      logOrchestratorEvent(context.orchestratorLog, "batch.merge_conflict.recovered", {
        batch_id: input.batchId,
        task_id: conflict.branch.taskId,
        branch: conflict.branch.branchName,
        message: conflict.message,
        action: "rescheduled",
      });
    }

    await context.stateStore.save(context.state);
    return true;
  };

  const applyFastForwardResult = async (input: {
    batchId: number;
    fastForwardResult: FastForwardResult;
    mergedTasks: TaskSuccessResult[];
  }): Promise<{
    mergeApplied: boolean;
    appliedTasks: TaskSuccessResult[];
    batchMergeCommit?: string;
    stateUpdated: boolean;
  }> => {
    if (input.fastForwardResult.status === "fast_forwarded") {
      return {
        mergeApplied: true,
        appliedTasks: input.mergedTasks,
        batchMergeCommit: input.fastForwardResult.head,
        stateUpdated: false,
      };
    }

    const reason =
      input.fastForwardResult.reason === "main_advanced"
        ? "main advanced during integration"
        : "fast-forward blocked";

    for (const task of input.mergedTasks) {
      resetTaskToPending(context.state, task.taskId, reason);
      logTaskReset(context.orchestratorLog, task.taskId, reason);
    }

    logOrchestratorEvent(context.orchestratorLog, "batch.fast_forward.blocked", {
      batch_id: input.batchId,
      reason: input.fastForwardResult.reason,
      message: input.fastForwardResult.message,
      current_head: input.fastForwardResult.currentHead,
      target_ref: input.fastForwardResult.targetRef,
      tasks: input.mergedTasks.map((task) => task.taskId),
      action: "rescheduled",
    });

    await context.stateStore.save(context.state);
    return {
      mergeApplied: false,
      appliedTasks: [],
      stateUpdated: true,
    };
  };

  const mergeValidatedTasks = async (input: {
    batchId: number;
    successfulTasks: TaskSuccessResult[];
    stopReason: BatchStopReason | undefined;
  }): Promise<MergeOutcome> => {
    const outcome: MergeOutcome = {
      mergedTasks: [],
      appliedTasks: [],
      mergeApplied: false,
      batchMergeCommit: undefined,
      integrationDoctorPassed: undefined,
      stopReason: input.stopReason,
      doctorCanaryResult: undefined,
      integrationDoctorFailureDetail: null,
      stateUpdated: false,
    };

    if (input.successfulTasks.length === 0 || outcome.stopReason) {
      return outcome;
    }

    logOrchestratorEvent(context.orchestratorLog, "batch.merging", {
      batch_id: input.batchId,
      tasks: input.successfulTasks.map((r) => r.taskId),
    });

    const tempBranch = buildTempMergeBranchName(context.runId, input.batchId);

    try {
      const mergeResult: TempMergeResult = await context.vcs.mergeTaskBranchesToTemp({
        repoPath: context.repoPath,
        mainBranch: context.config.main_branch,
        tempBranch,
        branches: input.successfulTasks.map((r) => ({
          taskId: r.taskId,
          branchName: r.branchName,
          workspacePath: r.workspace,
        })),
      });

      const successfulTasksById = new Map(
        input.successfulTasks.map((task) => [task.taskId, task]),
      );
      outcome.mergedTasks = mergeResult.merged
        .map((task) => successfulTasksById.get(task.taskId))
        .filter((task): task is TaskSuccessResult => task !== undefined);

      if (mergeResult.conflicts.length > 0) {
        const stateUpdated = await applyMergeConflicts({
          batchId: input.batchId,
          conflicts: mergeResult.conflicts,
        });
        outcome.stateUpdated = outcome.stateUpdated || stateUpdated;
      }

      if (outcome.mergedTasks.length > 0) {
        const doctorResult = await runIntegrationDoctor(input.batchId);
        outcome.integrationDoctorPassed = doctorResult.doctorOk;
        outcome.doctorCanaryResult = await resolveDoctorCanaryResult({
          batchId: input.batchId,
          doctorOk: doctorResult.doctorOk,
        });

        if (!doctorResult.doctorOk) {
          outcome.integrationDoctorFailureDetail = {
            exitCode: doctorResult.exitCode,
            output: doctorResult.output,
          };
          context.state.status = "failed";
          outcome.stopReason = "integration_doctor_failed";
        } else {
          const fastForwardResult = await context.vcs.fastForward({
            repoPath: context.repoPath,
            mainBranch: context.config.main_branch,
            targetRef: mergeResult.tempBranch,
            expectedBaseSha: mergeResult.baseSha,
            cleanupBranch: mergeResult.tempBranch,
          });

          const fastForwardOutcome = await applyFastForwardResult({
            batchId: input.batchId,
            fastForwardResult,
            mergedTasks: outcome.mergedTasks,
          });
          outcome.mergeApplied = fastForwardOutcome.mergeApplied;
          outcome.appliedTasks = fastForwardOutcome.appliedTasks;
          outcome.batchMergeCommit = fastForwardOutcome.batchMergeCommit;
          outcome.stateUpdated = outcome.stateUpdated || fastForwardOutcome.stateUpdated;
        }
      }
    } finally {
      await context.vcs.checkout(context.repoPath, context.config.main_branch).catch(() => undefined);
    }

    return outcome;
  };

  const runUnexpectedCanaryValidation = async (input: {
    appliedTasks: TaskSuccessResult[];
    blockedTasks: Set<string>;
    stopReason: BatchStopReason | undefined;
    doctorCanaryResult: DoctorCanaryResult | undefined;
    completed: Set<string>;
    failed: Set<string>;
  }): Promise<boolean> => {
    const canaryUnexpectedPass = input.doctorCanaryResult?.status === "unexpected_pass";
    if (
      !context.doctorValidatorEnabled ||
      !context.doctorValidatorConfig ||
      !canaryUnexpectedPass ||
      input.appliedTasks.length === 0 ||
      input.stopReason
    ) {
      return false;
    }

    const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
      doctorCommand: context.config.doctor,
      doctorCanary: input.doctorCanaryResult,
      trigger: "doctor_canary_failed",
      triggerNotes: `Doctor exited successfully with ${formatDoctorCanaryEnvVar(
        input.doctorCanaryResult?.envVar,
      )} (expected non-zero).`,
    });

    doctorValidatorLastCount = input.completed.size + input.failed.size;

    if (!doctorOutcome) {
      return false;
    }

    for (const r of input.appliedTasks) {
      applyDoctorOutcome(r.taskId, doctorOutcome, input.blockedTasks);
    }

    await context.stateStore.save(context.state);
    return true;
  };

  const finalizeTasksAfterMerge = async (input: {
    mergedTasks: TaskSuccessResult[];
    appliedTasks: TaskSuccessResult[];
    integrationDoctorFailureDetail: IntegrationDoctorFailureDetail | null;
    integrationDoctorPassed?: boolean;
    mergeApplied: boolean;
    stopReason: BatchStopReason | undefined;
  }): Promise<boolean> => {
    let finalizedTasks = false;

    if (
      input.stopReason === "integration_doctor_failed" &&
      input.integrationDoctorFailureDetail &&
      input.mergedTasks.length > 0
    ) {
      const rawOutput = input.integrationDoctorFailureDetail.output.trim();
      const summary = rawOutput.length > 0 ? rawOutput.slice(0, 500) : undefined;
      const reason = `Integration doctor failed (exit ${input.integrationDoctorFailureDetail.exitCode}).`;
      for (const task of input.mergedTasks) {
        markTaskNeedsHumanReview(context.state, task.taskId, {
          validator: "doctor",
          reason,
          summary,
        });
      }
      finalizedTasks = true;
    }

    if (
      !input.stopReason &&
      input.integrationDoctorPassed === true &&
      input.mergeApplied &&
      input.appliedTasks.length > 0
    ) {
      for (const task of input.appliedTasks) {
        markTaskComplete(context.state, task.taskId);
        logOrchestratorEvent(context.orchestratorLog, "task.complete", {
          taskId: task.taskId,
          attempts: context.state.tasks[task.taskId].attempts,
        });
      }
      finalizedTasks = true;
    }

    return finalizedTasks;
  };

  const computeBatchStatus = (input: {
    batchTasks: TaskSpec[];
    hadPendingResets: boolean;
    stopReason: BatchStopReason | undefined;
  }): "complete" | "failed" => {
    const failedTaskIds = input.batchTasks
      .map((t) => t.manifest.id)
      .filter((id) => {
        const status = context.state.tasks[id]?.status;
        return (
          status === "failed" ||
          status === "needs_human_review" ||
          status === "needs_rescope" ||
          status === "rescope_required"
        );
      });
    const pendingTaskIds = input.batchTasks
      .map((t) => t.manifest.id)
      .filter((id) => context.state.tasks[id]?.status === "pending");

    return failedTaskIds.length > 0 ||
      pendingTaskIds.length > 0 ||
      input.hadPendingResets ||
      input.stopReason
      ? "failed"
      : "complete";
  };

  const writeLedgerEntries = async (input: {
    batchId: number;
    batchTasks: TaskSpec[];
    batchMergeCommit?: string;
    mergeApplied: boolean;
    integrationDoctorPassed?: boolean;
  }): Promise<void> => {
    if (!input.batchMergeCommit || !input.mergeApplied || input.integrationDoctorPassed !== true) {
      return;
    }

    const ledgerCandidates = input.batchTasks.filter((task) => {
      const status = context.state.tasks[task.manifest.id]?.status;
      return status === "complete" || status === "skipped";
    });

    if (ledgerCandidates.length === 0) {
      return;
    }

    logOrchestratorEvent(context.orchestratorLog, "ledger.write.start", {
      batch_id: input.batchId,
      merge_commit: input.batchMergeCommit,
      tasks: ledgerCandidates.map((task) => task.manifest.id),
    });

    const ledgerCompleted: string[] = [];
    for (const task of ledgerCandidates) {
      const taskId = task.manifest.id;
      const manifestPath = resolveTaskManifestPath({
        tasksRoot: context.tasksRootAbs,
        stage: task.stage,
        taskDirName: task.taskDirName,
      });
      const specPath = resolveTaskSpecPath({
        tasksRoot: context.tasksRootAbs,
        stage: task.stage,
        taskDirName: task.taskDirName,
      });

      try {
        const fingerprint = await computeTaskFingerprint({ manifestPath, specPath });
        const completedAt = context.state.tasks[taskId]?.completed_at ?? isoNow();
        await upsertLedgerEntry(
          context.projectName,
          {
            taskId,
            status: context.state.tasks[taskId].status === "skipped" ? "skipped" : "complete",
            fingerprint,
            mergeCommit: input.batchMergeCommit,
            integrationDoctorPassed: true,
            completedAt,
            runId: context.runId,
            source: "executor",
          },
          context.paths,
        );
        ledgerCompleted.push(taskId);
      } catch (error) {
        logOrchestratorEvent(context.orchestratorLog, "ledger.write.error", {
          batch_id: input.batchId,
          taskId,
          message: formatErrorMessage(error),
        });
      }
    }

    logOrchestratorEvent(context.orchestratorLog, "ledger.write.complete", {
      batch_id: input.batchId,
      merge_commit: input.batchMergeCommit,
      tasks: ledgerCompleted,
    });
  };

  const runSuspiciousDoctorValidation = async (input: {
    batchId: number;
    mergedTasks: TaskSuccessResult[];
    blockedTasks: Set<string>;
    stopReason: BatchStopReason | undefined;
    integrationDoctorPassed?: boolean;
    postMergeFinishedCount: number;
  }): Promise<void> => {
    const shouldRunDoctorValidatorSuspicious =
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      input.integrationDoctorPassed === false;

    if (!shouldRunDoctorValidatorSuspicious || input.stopReason) {
      return;
    }

    const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
      doctorCommand: context.config.doctor,
      doctorCanary: lastIntegrationDoctorCanary,
      trigger: "integration_doctor_failed",
      triggerNotes: `Integration doctor failed for batch ${input.batchId} (exit code ${lastIntegrationDoctorExitCode ?? -1})`,
      integrationDoctorOutput: lastIntegrationDoctorOutput,
    });

    doctorValidatorLastCount = input.postMergeFinishedCount;

    if (!doctorOutcome) {
      return;
    }

    for (const r of input.mergedTasks) {
      applyDoctorOutcome(r.taskId, doctorOutcome, input.blockedTasks);
    }

    await context.stateStore.save(context.state);
  };

  const archiveAppliedTasks = async (input: {
    batchTasks: TaskSpec[];
    appliedTasks: TaskSuccessResult[];
    mergeApplied: boolean;
    integrationDoctorPassed?: boolean;
    stopReason: BatchStopReason | undefined;
  }): Promise<void> => {
    if (
      input.integrationDoctorPassed !== true ||
      !input.mergeApplied ||
      input.stopReason ||
      input.appliedTasks.length === 0
    ) {
      return;
    }

    const archiveIds = new Set(input.appliedTasks.map((task) => task.taskId));

    for (const task of input.batchTasks) {
      if (!archiveIds.has(task.manifest.id)) continue;
      if (task.stage === "legacy") continue;

      try {
        await context.taskEngine.ensureTaskActiveStage(task);
        const moveResult = await moveTaskDir({
          tasksRoot: context.tasksRootAbs,
          fromStage: "active",
          toStage: "archive",
          taskDirName: task.taskDirName,
          runId: context.runId,
        });

        if (moveResult.moved) {
          logOrchestratorEvent(context.orchestratorLog, "task.stage.move", {
            taskId: task.manifest.id,
            from: "active",
            to: "archive",
            path_from: moveResult.fromPath,
            path_to: moveResult.toPath,
          });
        }
      } catch (error) {
        logOrchestratorEvent(context.orchestratorLog, "task.stage.move_error", {
          taskId: task.manifest.id,
          message: formatErrorMessage(error),
        });
      }
    }
  };

  const finalizeBatch = async (params: {
    batchId: number;
    batchTasks: TaskSpec[];
    results: TaskRunResult[];
  }): Promise<BatchStopReason | undefined> => {
    const usageSnapshot = context.budgetTracker.recordUsageUpdates({
      state: context.state,
      taskResults: params.results.map((result) => ({
        taskId: result.taskId,
        taskSlug: result.taskSlug,
      })),
    });

    const hadPendingResets = params.results.some((r) => !r.success && r.resetToPending);
    const changeManifestBaseSha =
      context.state.control_plane?.base_sha ?? context.blastContext?.baseSha ?? "";
    const taskSpecsById = new Map(params.batchTasks.map((task) => [task.manifest.id, task]));

    await processTaskResults({
      taskSpecsById,
      results: params.results,
      changeManifestBaseSha,
    });

    let { completed, failed } = await refreshStatusSets();

    const blockedTasks = new Set<string>();
    await runValidationPhase({
      batchTasks: params.batchTasks,
      taskSpecsById,
      blockedTasks,
    });

    ({ completed, failed } = await refreshStatusSets());

    const budgetOutcome = context.budgetTracker.evaluateBreaches({
      state: context.state,
      snapshot: usageSnapshot,
    });
    let stopReason = budgetOutcome.stopReason;

    await runDoctorCadenceValidation({
      batchTasks: params.batchTasks,
      blockedTasks,
      completed,
      failed,
      stopReason,
    });

    ({ completed, failed } = await refreshStatusSets());

    const successfulTasks = context.taskEngine.buildValidatedTaskSummaries(params.batchTasks);
    const mergeOutcome = await mergeValidatedTasks({
      batchId: params.batchId,
      successfulTasks,
      stopReason,
    });

    const integrationDoctorPassed = mergeOutcome.integrationDoctorPassed;
    const doctorCanaryResult = mergeOutcome.doctorCanaryResult;
    stopReason = mergeOutcome.stopReason ?? stopReason;

    if (mergeOutcome.stateUpdated) {
      ({ completed, failed } = rebuildStatusSets());
    }

    const canaryStateUpdated = await runUnexpectedCanaryValidation({
      appliedTasks: mergeOutcome.appliedTasks,
      blockedTasks,
      stopReason,
      doctorCanaryResult,
      completed,
      failed,
    });
    if (canaryStateUpdated) {
      ({ completed, failed } = rebuildStatusSets());
    }

    const finalizedTasks = await finalizeTasksAfterMerge({
      mergedTasks: mergeOutcome.mergedTasks,
      appliedTasks: mergeOutcome.appliedTasks,
      integrationDoctorFailureDetail: mergeOutcome.integrationDoctorFailureDetail,
      integrationDoctorPassed,
      mergeApplied: mergeOutcome.mergeApplied,
      stopReason,
    });
    if (finalizedTasks) {
      ({ completed, failed } = await refreshStatusSets());
    }

    const batchStatus = computeBatchStatus({
      batchTasks: params.batchTasks,
      hadPendingResets,
      stopReason,
    });

    completeBatch(context.state, params.batchId, batchStatus, {
      mergeCommit: mergeOutcome.batchMergeCommit,
      integrationDoctorPassed,
      integrationDoctorCanary: buildDoctorCanarySummary(doctorCanaryResult),
    });
    await context.stateStore.save(context.state);

    await writeLedgerEntries({
      batchId: params.batchId,
      batchTasks: params.batchTasks,
      batchMergeCommit: mergeOutcome.batchMergeCommit,
      mergeApplied: mergeOutcome.mergeApplied,
      integrationDoctorPassed,
    });

    const postMergeFinishedCount = completed.size + failed.size;
    await runSuspiciousDoctorValidation({
      batchId: params.batchId,
      mergedTasks: mergeOutcome.mergedTasks,
      blockedTasks,
      stopReason,
      integrationDoctorPassed,
      postMergeFinishedCount,
    });

    await archiveAppliedTasks({
      batchTasks: params.batchTasks,
      appliedTasks: mergeOutcome.appliedTasks,
      mergeApplied: mergeOutcome.mergeApplied,
      integrationDoctorPassed,
      stopReason,
    });

    await cleanupSuccessfulBatchArtifacts({
      batchStatus,
      integrationDoctorPassed,
      successfulTasks: mergeOutcome.appliedTasks,
    });

    logOrchestratorEvent(context.orchestratorLog, "batch.complete", { batch_id: params.batchId });
    return stopReason;
  };

  return { finalizeBatch };
}


// =============================================================================
// MERGE HELPERS
// =============================================================================

function buildTempMergeBranchName(runId: string, batchId: number): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9_.-]/g, "-") || "run";
  return `mycelium/merge/${safeRunId}/${batchId}`;
}


// =============================================================================
// CHANGE MANIFEST
// =============================================================================

async function emitChangeManifestReport(input: {
  repoPath: string;
  runId: string;
  task: TaskSpec;
  workspacePath: string;
  baseSha: string;
  model: ControlPlaneModel | null;
  surfacePatterns: SurfacePatternSet;
  vcs: Vcs;
  orchestratorLog: JsonlLogger;
}): Promise<TaskChangeManifest | null> {
  const baseSha = input.baseSha.trim();
  if (!baseSha) {
    logOrchestratorEvent(input.orchestratorLog, "task.change_manifest.error", {
      taskId: input.task.manifest.id,
      task_slug: input.task.slug,
      message: "Missing base SHA for change manifest.",
    });
    return null;
  }

  try {
    const [headSha, changedFiles] = await Promise.all([
      input.vcs.headSha(input.workspacePath),
      input.vcs.listChangedFiles(input.workspacePath, baseSha),
    ]);
    const manifest = buildTaskChangeManifest({
      task: input.task.manifest,
      baseSha,
      headSha,
      changedFiles,
      model: input.model ?? undefined,
      surfacePatterns: input.surfacePatterns,
    });
    const reportPath = taskChangeManifestPath(input.repoPath, input.runId, input.task.manifest.id);

    await writeJsonFile(reportPath, manifest);

    logOrchestratorEvent(input.orchestratorLog, "task.change_manifest", {
      taskId: input.task.manifest.id,
      task_slug: input.task.slug,
      report_path: reportPath,
      changed_files: manifest.changed_files.length,
      touched_components: manifest.touched_components.length,
      impacted_components: manifest.impacted_components.length,
      surface_change: manifest.surface_change.is_surface_change,
      surface_categories: manifest.surface_change.categories,
    });

    return manifest;
  } catch (error) {
    logOrchestratorEvent(input.orchestratorLog, "task.change_manifest.error", {
      taskId: input.task.manifest.id,
      task_slug: input.task.slug,
      message: formatErrorMessage(error),
    });
    return null;
  }
}

// =============================================================================
// BLAST RADIUS
// =============================================================================

type BlastRadiusContext = {
  baseSha: string;
  model: ControlPlaneModel;
};

async function emitBlastRadiusReport(input: {
  repoPath: string;
  runId: string;
  task: TaskSpec;
  changedFiles: string[];
  blastContext: BlastRadiusContext;
  orchestratorLog: JsonlLogger;
}): Promise<ControlPlaneBlastRadiusReport | null> {
  const report = buildBlastRadiusReport({
    task: input.task.manifest,
    baseSha: input.blastContext.baseSha,
    changedFiles: input.changedFiles,
    model: input.blastContext.model,
  });
  const reportPath = taskBlastReportPath(input.repoPath, input.runId, input.task.manifest.id);

  await writeJsonFile(reportPath, report);

  logOrchestratorEvent(input.orchestratorLog, "task.blast_radius", {
    taskId: input.task.manifest.id,
    task_slug: input.task.slug,
    report_path: reportPath,
    confidence: report.confidence,
    touched_components: report.touched_components.length,
    impacted_components: report.impacted_components.length,
  });

  return report;
}

function recordBlastRadius(metrics: RunMetrics, report: ControlPlaneBlastRadiusReport): void {
  metrics.blastRadius.impactedComponentsTotal += report.impacted_components.length;
  metrics.blastRadius.reports += 1;
}

// =============================================================================
// VALIDATION + DOCTOR
// =============================================================================

function setValidatorResult(state: RunState, taskId: string, result: ValidatorResult): void {
  const task = state.tasks[taskId];
  if (!task) return;

  const existing = (task.validator_results ?? []).filter((r) => r.validator !== result.validator);
  task.validator_results = [...existing, result];
}

const DOCTOR_CANARY_OUTPUT_LIMIT = 4_000;

async function runDoctorCanary(args: {
  command: string;
  cwd: string;
  timeoutSeconds?: number;
  envVar: string;
}): Promise<DoctorCanaryResult> {
  const res = await execaCommand(args.command, {
    cwd: args.cwd,
    shell: true,
    reject: false,
    env: { ...process.env, [args.envVar]: "1" },
    timeout: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
  });

  const exitCode = res.exitCode ?? -1;
  const output = limitText(`${res.stdout}\n${res.stderr}`.trim(), DOCTOR_CANARY_OUTPUT_LIMIT);

  if (exitCode === 0) {
    return { status: "unexpected_pass", exitCode, output, envVar: args.envVar };
  }

  return { status: "expected_fail", exitCode, output, envVar: args.envVar };
}
