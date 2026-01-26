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
import {
  buildDoctorCanarySummary,
  formatDoctorCanaryEnvVar,
  limitText,
} from "../helpers/format.js";
import { formatErrorMessage } from "../helpers/errors.js";
import type { PolicyDecision, SurfacePatternSet } from "../../../control-plane/policy/types.js";
import type { ControlPlaneRunConfig } from "../run-context.js";
import type { BudgetTracker } from "../budgets/budget-tracker.js";
import type { CompliancePipeline } from "../compliance/compliance-pipeline.js";
import type { ValidationPipeline } from "../validation/validation-pipeline.js";
import type { DoctorValidationOutcome, ValidationOutcome } from "../validation/types.js";
import type { Vcs } from "../vcs/vcs.js";
import type { WorkerRunner } from "../workers/worker-runner.js";
import type { RunMetrics } from "./run-engine.js";
import type { TaskEngine, TaskRunResult, TaskSuccessResult } from "./task-engine.js";
import type { JsonObject, JsonlLogger } from "../../../core/logger.js";
import { logOrchestratorEvent, logTaskReset } from "../../../core/logger.js";
import type {
  ControlPlaneScopeMode,
  ManifestEnforcementPolicy,
  ProjectConfig,
} from "../../../core/config.js";
import { computeRescopeFromComponentScope } from "../../../core/manifest-rescope.js";
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
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { PathsContext } from "../../../core/paths.js";
import {
  resolveTaskManifestPath,
  resolveTaskSpecPath,
  moveTaskDir,
} from "../../../core/task-layout.js";
import { taskBlastReportPath, taskChangeManifestPath } from "../../../core/paths.js";
import { computeTaskFingerprint, upsertLedgerEntry } from "../../../core/task-ledger.js";
import type { StateStore } from "../../../core/state-store.js";
import { isoNow, writeJsonFile } from "../../../core/utils.js";
import { removeTaskWorkspace } from "../../../core/workspaces.js";
import type { DoctorCanaryResult } from "../../../validators/doctor-validator.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";

// =============================================================================
// TYPES
// =============================================================================

export type BatchStopReason = "merge_conflict" | "integration_doctor_failed" | "budget_block";

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
    let doctorCanaryResult: DoctorCanaryResult | undefined;
    for (const r of params.results) {
      const taskSpec = params.batchTasks.find((t) => t.manifest.id === r.taskId);

      let changeManifest: TaskChangeManifest | null = null;
      if (r.success && taskSpec) {
        changeManifest = await emitChangeManifestReport({
          repoPath: context.repoPath,
          runId: context.runId,
          task: taskSpec,
          workspacePath: r.workspace,
          baseSha: changeManifestBaseSha,
          model: context.blastContext?.model ?? null,
          surfacePatterns: context.controlPlaneConfig.surfacePatterns,
          vcs: context.vcs,
          orchestratorLog: context.orchestratorLog,
        });
      }

      if (context.blastContext && taskSpec) {
        try {
          const changedFiles =
            changeManifest?.changed_files ??
            (await context.vcs.listChangedFiles(r.workspace, context.blastContext.baseSha));
          const report = await emitBlastRadiusReport({
            repoPath: context.repoPath,
            runId: context.runId,
            task: taskSpec,
            changedFiles,
            blastContext: context.blastContext,
            orchestratorLog: context.orchestratorLog,
          });
          if (report) {
            recordBlastRadius(context.runMetrics, report);
          }
        } catch (error) {
          logOrchestratorEvent(context.orchestratorLog, "task.blast_radius.error", {
            taskId: r.taskId,
            task_slug: taskSpec.slug,
            message: formatErrorMessage(error),
          });
        }
      }

      if (!r.success) {
        if (r.resetToPending) {
          const reason = r.errorMessage ?? "Task reset to pending";
          resetTaskToPending(context.state, r.taskId, reason);
          logTaskReset(context.orchestratorLog, r.taskId, reason);
        } else {
          const errorMessage = r.errorMessage ?? "Task worker exited with a non-zero status";
          markTaskFailed(context.state, r.taskId, errorMessage);
          logOrchestratorEvent(context.orchestratorLog, "task.failed", {
            taskId: r.taskId,
            attempts: context.state.tasks[r.taskId].attempts,
            message: errorMessage,
          });
        }
        continue;
      }

      if (!taskSpec) {
        const message = "Task spec missing during finalizeBatch";
        markTaskFailed(context.state, r.taskId, message);
        logOrchestratorEvent(context.orchestratorLog, "task.failed", {
          taskId: r.taskId,
          attempts: context.state.tasks[r.taskId].attempts,
          message,
        });
        continue;
      }

      const policyDecision = context.policyDecisions.get(r.taskId);
      const complianceOutcome = await context.compliancePipeline.runForTask({
        task: taskSpec,
        taskResult: {
          taskId: r.taskId,
          taskSlug: r.taskSlug,
          workspacePath: r.workspace,
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
        taskId: r.taskId,
        changeManifest,
      });
    }

    await context.stateStore.save(context.state);
    let { completed, failed } = context.buildStatusSets(context.state);

    const readyForValidation = context.taskEngine.buildReadyForValidationSummaries(
      params.batchTasks,
    );
    const blockedTasks = new Set<string>();
    const taskSpecsById = new Map(params.batchTasks.map((task) => [task.manifest.id, task]));

    if (context.validationPipeline) {
      for (const r of readyForValidation) {
        const taskSpec = taskSpecsById.get(r.taskId);
        if (!taskSpec) continue;

        const outcome = await context.validationPipeline.runForTask({
          task: taskSpec,
          workspacePath: r.workspace,
          logsDir: r.logsDir,
        });

        applyValidationOutcome(r.taskId, outcome, blockedTasks);
      }
    }

    const validatedTaskIds = readyForValidation
      .map((task) => task.taskId)
      .filter((taskId) => !blockedTasks.has(taskId));
    for (const taskId of validatedTaskIds) {
      markTaskValidated(context.state, taskId);
    }

    await context.stateStore.save(context.state);
    ({ completed, failed } = context.buildStatusSets(context.state));

    let batchMergeCommit: string | undefined;
    let integrationDoctorPassed: boolean | undefined;
    let stopReason: BatchStopReason | undefined;
    let mergeConflictDetail: { taskId: string; branchName: string; message: string } | null = null;
    let integrationDoctorFailureDetail: { exitCode: number; output: string } | null = null;

    const budgetOutcome = context.budgetTracker.evaluateBreaches({
      state: context.state,
      snapshot: usageSnapshot,
    });
    if (budgetOutcome.stopReason) {
      stopReason = budgetOutcome.stopReason;
    }

    const finishedCount = completed.size + failed.size;
    const shouldRunDoctorValidatorCadence =
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      doctorValidatorRunEvery !== undefined &&
      finishedCount - doctorValidatorLastCount >= doctorValidatorRunEvery;

    if (
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      shouldRunDoctorValidatorCadence &&
      !stopReason
    ) {
      const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
        doctorCommand: context.config.doctor,
        doctorCanary: lastIntegrationDoctorCanary,
        trigger: "cadence",
        triggerNotes: `Cadence reached after ${finishedCount} tasks (interval ${doctorValidatorRunEvery})`,
      });
      doctorValidatorLastCount = finishedCount;

      if (doctorOutcome) {
        const recipients = context.taskEngine.buildValidatedTaskSummaries(params.batchTasks);

        for (const r of recipients) {
          applyDoctorOutcome(r.taskId, doctorOutcome, blockedTasks);
        }
      }
    }

    await context.stateStore.save(context.state);
    ({ completed, failed } = context.buildStatusSets(context.state));

    const successfulTasks = context.taskEngine.buildValidatedTaskSummaries(params.batchTasks);

    if (successfulTasks.length > 0 && !stopReason) {
      logOrchestratorEvent(context.orchestratorLog, "batch.merging", {
        batch_id: params.batchId,
        tasks: successfulTasks.map((r) => r.taskId),
      });

      const mergeResult = await context.vcs.mergeTaskBranches({
        repoPath: context.repoPath,
        mainBranch: context.config.main_branch,
        branches: successfulTasks.map((r) => ({
          taskId: r.taskId,
          branchName: r.branchName,
          workspacePath: r.workspace,
        })),
      });

      if (mergeResult.status === "conflict") {
        batchMergeCommit = mergeResult.mergeCommit;
        mergeConflictDetail = {
          taskId: mergeResult.conflict.taskId,
          branchName: mergeResult.conflict.branchName,
          message: mergeResult.message,
        };
        logOrchestratorEvent(context.orchestratorLog, "batch.merge_conflict", {
          batch_id: params.batchId,
          task_id: mergeResult.conflict.taskId,
          branch: mergeResult.conflict.branchName,
          message: mergeResult.message,
        });
        context.state.status = "failed";
        stopReason = "merge_conflict";
      } else {
        batchMergeCommit = mergeResult.mergeCommit;

        logOrchestratorEvent(context.orchestratorLog, "doctor.integration.start", {
          batch_id: params.batchId,
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
            batch_id: params.batchId,
            exit_code: doctorExitCode,
          },
        );
        integrationDoctorPassed = doctorOk;

        if (doctorOk) {
          if (context.doctorCanaryConfig.mode === "off") {
            doctorCanaryResult = { status: "skipped", reason: "Disabled by config" };
            lastIntegrationDoctorCanary = doctorCanaryResult;
            logOrchestratorEvent(context.orchestratorLog, "doctor.canary.skipped", {
              batch_id: params.batchId,
              payload: {
                reason: "disabled_by_config",
                message: "Doctor canary disabled via doctor_canary.mode=off.",
              },
            });
          } else {
            logOrchestratorEvent(context.orchestratorLog, "doctor.canary.start", {
              batch_id: params.batchId,
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
            lastIntegrationDoctorCanary = doctorCanaryResult;

            if (doctorCanaryResult.status === "unexpected_pass") {
              const envLabel = formatDoctorCanaryEnvVar(doctorCanaryResult.envVar);
              const severity = context.doctorCanaryConfig.warn_on_unexpected_pass
                ? "warn"
                : "error";
              logOrchestratorEvent(context.orchestratorLog, "doctor.canary.unexpected_pass", {
                batch_id: params.batchId,
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
                batch_id: params.batchId,
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
          lastIntegrationDoctorCanary = doctorCanaryResult;
          logOrchestratorEvent(context.orchestratorLog, "doctor.canary.skipped", {
            batch_id: params.batchId,
            payload: {
              reason: "integration_doctor_failed",
              message: "Skipping canary because integration doctor failed.",
            },
          });
        }

        if (!doctorOk) {
          integrationDoctorFailureDetail = {
            exitCode: doctorExitCode,
            output: lastIntegrationDoctorOutput ?? "",
          };
          context.state.status = "failed";
          stopReason = "integration_doctor_failed";
        }
      }
    }

    const canaryUnexpectedPass = doctorCanaryResult?.status === "unexpected_pass";
    if (
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      canaryUnexpectedPass &&
      successfulTasks.length > 0 &&
      !stopReason
    ) {
      const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
        doctorCommand: context.config.doctor,
        doctorCanary: doctorCanaryResult,
        trigger: "doctor_canary_failed",
        triggerNotes: `Doctor exited successfully with ${formatDoctorCanaryEnvVar(
          doctorCanaryResult?.envVar,
        )} (expected non-zero).`,
      });

      doctorValidatorLastCount = completed.size + failed.size;

      if (doctorOutcome) {
        for (const r of successfulTasks) {
          applyDoctorOutcome(r.taskId, doctorOutcome, blockedTasks);
        }
        await context.stateStore.save(context.state);
        ({ completed, failed } = context.buildStatusSets(context.state));
      }
    }

    const markTasksForHumanReview = (
      tasks: TaskSuccessResult[],
      reason: string,
      summary?: string,
    ): void => {
      for (const task of tasks) {
        markTaskNeedsHumanReview(context.state, task.taskId, {
          validator: "doctor",
          reason,
          summary,
        });
      }
    };

    let finalizedTasks = false;
    if (stopReason === "merge_conflict" && mergeConflictDetail && successfulTasks.length > 0) {
      const reason = `Merge conflict while merging ${mergeConflictDetail.branchName} (task ${mergeConflictDetail.taskId}).`;
      const summary = mergeConflictDetail.message;
      markTasksForHumanReview(successfulTasks, reason, summary);
      finalizedTasks = true;
    }

    if (
      stopReason === "integration_doctor_failed" &&
      integrationDoctorFailureDetail &&
      successfulTasks.length > 0
    ) {
      const rawOutput = integrationDoctorFailureDetail.output.trim();
      const summary = rawOutput.length > 0 ? rawOutput.slice(0, 500) : undefined;
      const reason = `Integration doctor failed (exit ${integrationDoctorFailureDetail.exitCode}).`;
      markTasksForHumanReview(successfulTasks, reason, summary);
      finalizedTasks = true;
    }

    if (!stopReason && integrationDoctorPassed === true && successfulTasks.length > 0) {
      for (const task of successfulTasks) {
        markTaskComplete(context.state, task.taskId);
        logOrchestratorEvent(context.orchestratorLog, "task.complete", {
          taskId: task.taskId,
          attempts: context.state.tasks[task.taskId].attempts,
        });
      }
      finalizedTasks = true;
    }

    if (finalizedTasks) {
      await context.stateStore.save(context.state);
      ({ completed, failed } = context.buildStatusSets(context.state));
    }

    const failedTaskIds = params.batchTasks
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
    const pendingTaskIds = params.batchTasks
      .map((t) => t.manifest.id)
      .filter((id) => context.state.tasks[id]?.status === "pending");
    const batchStatus: "complete" | "failed" =
      failedTaskIds.length > 0 || pendingTaskIds.length > 0 || hadPendingResets || stopReason
        ? "failed"
        : "complete";

    completeBatch(context.state, params.batchId, batchStatus, {
      mergeCommit: batchMergeCommit,
      integrationDoctorPassed,
      integrationDoctorCanary: buildDoctorCanarySummary(doctorCanaryResult),
    });
    await context.stateStore.save(context.state);

    if (integrationDoctorPassed === true && batchMergeCommit) {
      const ledgerCandidates = params.batchTasks.filter((task) => {
        const status = context.state.tasks[task.manifest.id]?.status;
        return status === "complete" || status === "skipped";
      });

      if (ledgerCandidates.length > 0) {
        logOrchestratorEvent(context.orchestratorLog, "ledger.write.start", {
          batch_id: params.batchId,
          merge_commit: batchMergeCommit,
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
                mergeCommit: batchMergeCommit,
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
              batch_id: params.batchId,
              taskId,
              message: formatErrorMessage(error),
            });
          }
        }

        logOrchestratorEvent(context.orchestratorLog, "ledger.write.complete", {
          batch_id: params.batchId,
          merge_commit: batchMergeCommit,
          tasks: ledgerCompleted,
        });
      }
    }

    const postMergeFinishedCount = completed.size + failed.size;
    const shouldRunDoctorValidatorSuspicious =
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      integrationDoctorPassed === false;

    if (
      context.doctorValidatorEnabled &&
      context.doctorValidatorConfig &&
      shouldRunDoctorValidatorSuspicious &&
      !stopReason
    ) {
      const doctorOutcome = await context.validationPipeline?.runDoctorValidation({
        doctorCommand: context.config.doctor,
        doctorCanary: lastIntegrationDoctorCanary,
        trigger: "integration_doctor_failed",
        triggerNotes: `Integration doctor failed for batch ${params.batchId} (exit code ${lastIntegrationDoctorExitCode ?? -1})`,
        integrationDoctorOutput: lastIntegrationDoctorOutput,
      });

      doctorValidatorLastCount = postMergeFinishedCount;

      if (doctorOutcome) {
        for (const r of successfulTasks) {
          applyDoctorOutcome(r.taskId, doctorOutcome, blockedTasks);
        }
        await context.stateStore.save(context.state);
      }
    }

    if (integrationDoctorPassed === true && !stopReason && successfulTasks.length > 0) {
      const archiveIds = new Set(successfulTasks.map((task) => task.taskId));

      for (const task of params.batchTasks) {
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
    }

    await cleanupSuccessfulBatchArtifacts({
      batchStatus,
      integrationDoctorPassed,
      successfulTasks,
    });

    logOrchestratorEvent(context.orchestratorLog, "batch.complete", { batch_id: params.batchId });
    return stopReason;
  };

  return { finalizeBatch };
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
