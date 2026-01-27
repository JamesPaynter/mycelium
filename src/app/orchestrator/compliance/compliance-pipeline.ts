/**
 * CompliancePipeline centralizes manifest compliance checks and rescope decisions.
 * Purpose: run compliance, log access events, and apply rescope updates.
 * Assumptions: caller provides state/task spec; pipeline owns compliance I/O.
 * Usage: const pipeline = new CompliancePipeline(options); await pipeline.runForTask(ctx).
 */

import type { PolicyDecision } from "../../../control-plane/policy/types.js";
import type {
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
  ManifestEnforcementPolicy,
  ResourceConfig,
} from "../../../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../../../core/logger.js";
import {
  runManifestCompliance,
  type ManifestComplianceResult,
  type ManifestComplianceViolation,
  type ResourceOwnerResolver,
  type ResourceOwnershipResolver,
} from "../../../core/manifest-compliance.js";
import type { PathsContext } from "../../../core/paths.js";
import { taskComplianceReportPath } from "../../../core/paths.js";
import { markTaskRescopeRequired, resetTaskToPending, type RunState } from "../../../core/state.js";
import { resolveTaskManifestPath } from "../../../core/task-layout.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import { writeJsonFile } from "../../../core/utils.js";

import {
  buildComplianceRescopePlan,
  countScopeViolations,
  logComplianceEvents,
  resolveCompliancePolicyForScope,
  resolveCompliancePolicyForTier,
  type ComplianceRescopePlan,
  type ComplianceScopeViolations,
} from "./compliance-helpers.js";

export { buildComplianceRescopePlan, resolveCompliancePolicyForTier } from "./compliance-helpers.js";
export type { ComplianceRescopePlan, ComplianceScopeViolations } from "./compliance-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export type ComplianceResourceContext = {
  resources: ResourceConfig[];
  staticResources: ResourceConfig[];
  fallbackResource: string;
  ownerResolver?: ResourceOwnerResolver;
  ownershipResolver?: ResourceOwnershipResolver;
  resourcesMode?: ControlPlaneResourcesMode;
};

export type CompliancePipelineOptions = {
  projectName: string;
  runId: string;
  tasksRoot: string;
  mainBranch: string;
  resourceContext: ComplianceResourceContext;
  orchestratorLog: JsonlLogger;
  paths?: PathsContext;
};

export type CompliancePipelineTaskContext = {
  task: TaskSpec;
  taskResult: {
    taskId: string;
    taskSlug: string;
    workspacePath: string;
  };
  state: RunState;
  scopeMode: ControlPlaneScopeMode;
  manifestPolicy: ManifestEnforcementPolicy;
  policyTier?: PolicyDecision["tier"];
};

export type ComplianceRescopeOutcome =
  | { status: "skipped"; reason: string }
  | {
      status: "updated";
      reason: string;
      addedLocks: string[];
      addedFiles: string[];
      manifestPath: string;
    }
  | { status: "failed"; reason: string };

export type CompliancePipelineOutcome = {
  effectivePolicy: ManifestEnforcementPolicy;
  reportPath: string;
  compliance: ManifestComplianceResult;
  scopeViolations: ComplianceScopeViolations;
  rescope: ComplianceRescopeOutcome;
};


// =============================================================================
// COMPLIANCE PIPELINE
// =============================================================================

export class CompliancePipeline {
  private readonly projectName: string;
  private readonly runId: string;
  private readonly tasksRoot: string;
  private readonly mainBranch: string;
  private readonly resourceContext: ComplianceResourceContext;
  private readonly orchestratorLog: JsonlLogger;
  private readonly paths?: PathsContext;

  constructor(options: CompliancePipelineOptions) {
    this.projectName = options.projectName;
    this.runId = options.runId;
    this.tasksRoot = options.tasksRoot;
    this.mainBranch = options.mainBranch;
    this.resourceContext = options.resourceContext;
    this.orchestratorLog = options.orchestratorLog;
    this.paths = options.paths;
  }

  async runForTask(input: CompliancePipelineTaskContext): Promise<CompliancePipelineOutcome> {
    const basePolicy = resolveCompliancePolicyForScope({
      scopeMode: input.scopeMode,
      manifestPolicy: input.manifestPolicy,
    });
    const effectivePolicy = resolveCompliancePolicyForTier({
      basePolicy,
      tier: input.policyTier,
    });
    const reportPath = taskComplianceReportPath(
      this.projectName,
      this.runId,
      input.taskResult.taskId,
      input.taskResult.taskSlug,
      this.paths,
    );

    const compliance = await runManifestCompliance({
      workspacePath: input.taskResult.workspacePath,
      mainBranch: this.mainBranch,
      manifest: input.task.manifest,
      resources: this.resourceContext.resources,
      staticResources: this.resourceContext.staticResources,
      fallbackResource: this.resourceContext.fallbackResource,
      ownerResolver: this.resourceContext.ownerResolver,
      ownershipResolver: this.resourceContext.ownershipResolver,
      resourcesMode: this.resourceContext.resourcesMode,
      policy: effectivePolicy,
      reportPath,
    });

    logComplianceEvents({
      orchestratorLog: this.orchestratorLog,
      taskId: input.taskResult.taskId,
      taskSlug: input.taskResult.taskSlug,
      policy: effectivePolicy,
      scopeMode: input.scopeMode,
      reportPath,
      result: compliance,
    });

    const scopeViolations = countScopeViolations(compliance);
    const rescopePlan = buildComplianceRescopePlan({
      compliance,
      manifest: input.task.manifest,
      shouldEnforce: input.scopeMode === "enforce",
    });
    const rescopeOutcome = await this.applyRescopePlan({
      plan: rescopePlan,
      task: input.task,
      taskResult: input.taskResult,
      state: input.state,
      reportPath,
      effectivePolicy,
      violations: compliance.violations,
    });

    return {
      effectivePolicy,
      reportPath,
      compliance,
      scopeViolations,
      rescope: rescopeOutcome,
    };
  }

  private async applyRescopePlan(input: {
    plan: ComplianceRescopePlan;
    task: TaskSpec;
    taskResult: CompliancePipelineTaskContext["taskResult"];
    state: RunState;
    reportPath: string;
    effectivePolicy: ManifestEnforcementPolicy;
    violations: ManifestComplianceViolation[];
  }): Promise<ComplianceRescopeOutcome> {
    if (input.plan.status === "skipped") {
      return { status: "skipped", reason: input.plan.reason };
    }

    markTaskRescopeRequired(input.state, input.taskResult.taskId, input.plan.rescopeReason);
    logOrchestratorEvent(this.orchestratorLog, "task.rescope.start", {
      taskId: input.taskResult.taskId,
      violations: input.violations.length,
      report_path: input.reportPath,
      policy: input.effectivePolicy,
    });

    if (input.plan.rescope.status === "updated") {
      const manifestPath = resolveTaskManifestPath({
        tasksRoot: this.tasksRoot,
        stage: input.task.stage,
        taskDirName: input.task.taskDirName,
      });
      await writeJsonFile(manifestPath, input.plan.rescope.manifest);
      input.task.manifest = input.plan.rescope.manifest;

      const resetReason = `Rescoped manifest: +${input.plan.rescope.addedLocks.length} locks, +${input.plan.rescope.addedFiles.length} files`;
      resetTaskToPending(input.state, input.taskResult.taskId, resetReason);
      logOrchestratorEvent(this.orchestratorLog, "task.rescope.updated", {
        taskId: input.taskResult.taskId,
        added_locks: input.plan.rescope.addedLocks,
        added_files: input.plan.rescope.addedFiles,
        manifest_path: manifestPath,
        report_path: input.reportPath,
      });

      return {
        status: "updated",
        reason: resetReason,
        addedLocks: input.plan.rescope.addedLocks,
        addedFiles: input.plan.rescope.addedFiles,
        manifestPath,
      };
    }

    const failedReason = input.plan.rescope.reason ?? input.plan.rescopeReason;
    const taskState = input.state.tasks[input.taskResult.taskId];
    if (taskState) {
      taskState.last_error = failedReason;
    }

    logOrchestratorEvent(this.orchestratorLog, "task.rescope.failed", {
      taskId: input.taskResult.taskId,
      reason: failedReason,
      violations: input.violations.length,
      report_path: input.reportPath,
    });

    return { status: "failed", reason: failedReason };
  }
}
