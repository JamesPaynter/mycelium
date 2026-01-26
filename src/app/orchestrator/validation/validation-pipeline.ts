/**
 * ValidationPipeline centralizes validator execution and normalization.
 * Purpose: run validators, normalize outputs, and surface block reasons for the executor.
 * Assumptions: validators write their own reports; pipeline reads reports for summaries.
 * Usage: const pipeline = new ValidationPipeline(options); await pipeline.runForTask(ctx).
 */

import path from "node:path";

import fse from "fs-extra";

import type { ProjectConfig } from "../../../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../../../core/logger.js";
import type { PathsContext } from "../../../core/paths.js";
import { runLogsDir, validatorLogPath, validatorReportPath, validatorsLogsDir } from "../../../core/paths.js";
import type { ValidatorStatus } from "../../../core/state.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import {
  runArchitectureValidator,
  type ArchitectureValidationReport,
  VALIDATOR_ID as ARCHITECTURE_VALIDATOR_ID,
  VALIDATOR_NAME as ARCHITECTURE_VALIDATOR_NAME,
} from "../../../validators/architecture-validator.js";
import {
  runDoctorValidator,
  type DoctorCanaryResult,
  type DoctorValidationReport,
  type DoctorValidatorTrigger,
  VALIDATOR_ID as DOCTOR_VALIDATOR_ID,
  VALIDATOR_NAME as DOCTOR_VALIDATOR_NAME,
} from "../../../validators/doctor-validator.js";
import {
  runStyleValidator,
  type StyleValidationReport,
  VALIDATOR_ID as STYLE_VALIDATOR_ID,
  VALIDATOR_NAME as STYLE_VALIDATOR_NAME,
} from "../../../validators/style-validator.js";
import {
  runTestValidator,
  type TestValidationReport,
  VALIDATOR_ID as TEST_VALIDATOR_ID,
  VALIDATOR_NAME as TEST_VALIDATOR_NAME,
} from "../../../validators/test-validator.js";
import { formatErrorMessage } from "../helpers/errors.js";
import {
  summarizeArchitectureReport,
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "./summaries.js";
import type { ValidatorRunner } from "../ports.js";
import type { RunValidatorConfig } from "../run-context.js";

import type { DoctorValidationOutcome, ValidationBlock, ValidationOutcome, ValidationResult } from "./types.js";


// =============================================================================
// TYPES
// =============================================================================

export type ValidationPipelineOptions = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  mainBranch: string;
  paths?: PathsContext;
  validators: {
    test: RunValidatorConfig<ProjectConfig["test_validator"]>;
    style: RunValidatorConfig<ProjectConfig["style_validator"]>;
    architecture: RunValidatorConfig<ProjectConfig["architecture_validator"]>;
    doctor: RunValidatorConfig<ProjectConfig["doctor_validator"]>;
    doctorCanary: ProjectConfig["doctor_canary"];
  };
  orchestratorLog: JsonlLogger;
  runner?: ValidatorRunner;
  onChecksetDuration?: (durationMs: number) => void;
  onDoctorDuration?: (durationMs: number) => void;
};

type ValidationTaskContext = {
  task: TaskSpec;
  workspacePath: string;
  logsDir: string;
};

type DoctorValidationContext = {
  doctorCommand: string;
  trigger: DoctorValidatorTrigger;
  triggerNotes?: string;
  integrationDoctorOutput?: string;
  doctorCanary?: DoctorCanaryResult;
};

type ValidationStepOutcome = {
  result: ValidationResult;
  blocked: ValidationBlock | null;
};

type ValidatorRunSummary = {
  status: ValidatorStatus;
  summary: string | null;
  reportPath: string | null;
  trigger?: string;
};


// =============================================================================
// CONSTANTS
// =============================================================================

const VALIDATOR_LABELS: Record<ValidationResult["validator"], string> = {
  test: "Test",
  style: "Style",
  architecture: "Architecture",
  doctor: "Doctor",
};

const DEFAULT_RUNNER: ValidatorRunner = {
  runDoctorValidator,
  runTestValidator,
  runStyleValidator,
  runArchitectureValidator,
};


// =============================================================================
// VALIDATION PIPELINE
// =============================================================================

export class ValidationPipeline {
  private readonly projectName: string;
  private readonly repoPath: string;
  private readonly runId: string;
  private readonly tasksRoot: string;
  private readonly mainBranch: string;
  private readonly paths?: PathsContext;
  private readonly validators: ValidationPipelineOptions["validators"];
  private readonly orchestratorLog: JsonlLogger;
  private readonly runner: ValidatorRunner;
  private readonly onChecksetDuration?: (durationMs: number) => void;
  private readonly onDoctorDuration?: (durationMs: number) => void;

  private testLogger?: JsonlLogger;
  private styleLogger?: JsonlLogger;
  private architectureLogger?: JsonlLogger;
  private doctorLogger?: JsonlLogger;

  constructor(options: ValidationPipelineOptions) {
    this.projectName = options.projectName;
    this.repoPath = options.repoPath;
    this.runId = options.runId;
    this.tasksRoot = options.tasksRoot;
    this.mainBranch = options.mainBranch;
    this.paths = options.paths;
    this.validators = options.validators;
    this.orchestratorLog = options.orchestratorLog;
    this.runner = options.runner ?? DEFAULT_RUNNER;
    this.onChecksetDuration = options.onChecksetDuration;
    this.onDoctorDuration = options.onDoctorDuration;

    if (this.validators.test.enabled) {
      this.testLogger = new JsonlLogger(
        validatorLogPath(this.projectName, this.runId, TEST_VALIDATOR_NAME, this.paths),
        { runId: this.runId },
      );
    }
    if (this.validators.style.enabled) {
      this.styleLogger = new JsonlLogger(
        validatorLogPath(this.projectName, this.runId, STYLE_VALIDATOR_NAME, this.paths),
        { runId: this.runId },
      );
    }
    if (this.validators.architecture.enabled) {
      this.architectureLogger = new JsonlLogger(
        validatorLogPath(this.projectName, this.runId, ARCHITECTURE_VALIDATOR_NAME, this.paths),
        { runId: this.runId },
      );
    }
    if (this.validators.doctor.enabled) {
      this.doctorLogger = new JsonlLogger(
        validatorLogPath(this.projectName, this.runId, DOCTOR_VALIDATOR_NAME, this.paths),
        { runId: this.runId },
      );
    }
  }

  close(): void {
    this.testLogger?.close();
    this.styleLogger?.close();
    this.architectureLogger?.close();
    this.doctorLogger?.close();
  }

  async runForTask(context: ValidationTaskContext): Promise<ValidationOutcome> {
    const results: ValidationResult[] = [];
    const blocked: ValidationBlock[] = [];

    if (this.validators.test.enabled && this.validators.test.config) {
      const outcome = await this.runTestValidation(context);
      results.push(outcome.result);
      if (outcome.blocked) blocked.push(outcome.blocked);
    }

    if (this.validators.style.enabled && this.validators.style.config) {
      const outcome = await this.runStyleValidation(context);
      results.push(outcome.result);
      if (outcome.blocked) blocked.push(outcome.blocked);
    }

    if (this.validators.architecture.enabled && this.validators.architecture.config) {
      const outcome = await this.runArchitectureValidation(context);
      results.push(outcome.result);
      if (outcome.blocked) blocked.push(outcome.blocked);
    }

    return {
      taskId: context.task.manifest.id,
      results,
      blocked,
    };
  }

  async runDoctorValidation(
    context: DoctorValidationContext,
  ): Promise<DoctorValidationOutcome | null> {
    if (!this.validators.doctor.enabled || !this.validators.doctor.config) {
      return null;
    }

    const reportDir = path.join(
      validatorsLogsDir(this.projectName, this.runId, this.paths),
      DOCTOR_VALIDATOR_NAME,
    );
    const before = await listValidatorReports(reportDir);

    let doctorResult: DoctorValidationReport | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    try {
      doctorResult = await this.runner.runDoctorValidator({
        projectName: this.projectName,
        repoPath: this.repoPath,
        runId: this.runId,
        mainBranch: this.mainBranch,
        doctorCommand: context.doctorCommand,
        doctorCanary: context.doctorCanary,
        trigger: context.trigger,
        triggerNotes: context.triggerNotes,
        integrationDoctorOutput: context.integrationDoctorOutput,
        config: this.validators.doctor.config,
        orchestratorLog: this.orchestratorLog,
        logger: this.doctorLogger,
        paths: this.paths,
      });
    } catch (err) {
      error = formatErrorMessage(err);
    } finally {
      this.onDoctorDuration?.(Date.now() - startedAt);
    }

    const reportPath = await findLatestReport(reportDir, before);
    if (doctorResult) {
      const status: ValidatorStatus =
        context.doctorCanary?.status === "unexpected_pass"
          ? "fail"
          : doctorResult.effective
            ? "pass"
            : "fail";

      const normalized = this.buildValidationResult({
        validator: DOCTOR_VALIDATOR_ID,
        status,
        summary: summarizeDoctorReport(doctorResult, context.doctorCanary),
        reportPath: relativeReportPath(this.projectName, this.runId, reportPath, this.paths),
        mode: this.validators.doctor.mode,
        trigger: context.trigger,
      });

      return { result: normalized, blocked: this.buildBlockResult(normalized) };
    }

    const normalized = this.buildValidationResult({
      validator: DOCTOR_VALIDATOR_ID,
      status: "error",
      summary: error ?? "Doctor validator returned no result (see validator log).",
      reportPath: relativeReportPath(this.projectName, this.runId, reportPath, this.paths),
      mode: this.validators.doctor.mode,
      trigger: context.trigger,
    });
    return { result: normalized, blocked: this.buildBlockResult(normalized) };
  }

  private async runTestValidation(context: ValidationTaskContext): Promise<ValidationStepOutcome> {
    const reportPath = validatorReportPath(
      this.projectName,
      this.runId,
      TEST_VALIDATOR_NAME,
      context.task.manifest.id,
      context.task.slug,
      this.paths,
    );

    let result: TestValidationReport | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    try {
      result = await this.runner.runTestValidator({
        projectName: this.projectName,
        repoPath: this.repoPath,
        runId: this.runId,
        tasksRoot: this.tasksRoot,
        task: context.task,
        taskSlug: context.task.slug,
        workspacePath: context.workspacePath,
        taskLogsDir: context.logsDir,
        mainBranch: this.mainBranch,
        config: this.validators.test.config,
        orchestratorLog: this.orchestratorLog,
        logger: this.testLogger,
        paths: this.paths,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logOrchestratorEvent(this.orchestratorLog, "validator.error", {
        validator: TEST_VALIDATOR_ID,
        taskId: context.task.manifest.id,
        message: error,
      });
    } finally {
      this.onChecksetDuration?.(Date.now() - startedAt);
    }

    const summary = await summarizeTestValidatorResult(reportPath, result, error);
    const normalized = this.buildValidationResult({
      validator: TEST_VALIDATOR_ID,
      status: summary.status,
      summary: summary.summary,
      reportPath: relativeReportPath(this.projectName, this.runId, summary.reportPath, this.paths),
      mode: this.validators.test.mode,
    });

    return { result: normalized, blocked: this.buildBlockResult(normalized) };
  }

  private async runStyleValidation(context: ValidationTaskContext): Promise<ValidationStepOutcome> {
    const reportPath = validatorReportPath(
      this.projectName,
      this.runId,
      STYLE_VALIDATOR_NAME,
      context.task.manifest.id,
      context.task.slug,
      this.paths,
    );

    let result: StyleValidationReport | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    try {
      result = await this.runner.runStyleValidator({
        projectName: this.projectName,
        repoPath: this.repoPath,
        runId: this.runId,
        tasksRoot: this.tasksRoot,
        task: context.task,
        taskSlug: context.task.slug,
        workspacePath: context.workspacePath,
        mainBranch: this.mainBranch,
        config: this.validators.style.config,
        orchestratorLog: this.orchestratorLog,
        logger: this.styleLogger,
        paths: this.paths,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logOrchestratorEvent(this.orchestratorLog, "validator.error", {
        validator: STYLE_VALIDATOR_ID,
        taskId: context.task.manifest.id,
        message: error,
      });
    } finally {
      this.onChecksetDuration?.(Date.now() - startedAt);
    }

    const summary = await summarizeStyleValidatorResult(reportPath, result, error);
    const normalized = this.buildValidationResult({
      validator: STYLE_VALIDATOR_ID,
      status: summary.status,
      summary: summary.summary,
      reportPath: relativeReportPath(this.projectName, this.runId, summary.reportPath, this.paths),
      mode: this.validators.style.mode,
    });

    return { result: normalized, blocked: this.buildBlockResult(normalized) };
  }

  private async runArchitectureValidation(
    context: ValidationTaskContext,
  ): Promise<ValidationStepOutcome> {
    const reportPath = validatorReportPath(
      this.projectName,
      this.runId,
      ARCHITECTURE_VALIDATOR_NAME,
      context.task.manifest.id,
      context.task.slug,
      this.paths,
    );

    let result: ArchitectureValidationReport | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    try {
      result = await this.runner.runArchitectureValidator({
        projectName: this.projectName,
        repoPath: this.repoPath,
        runId: this.runId,
        tasksRoot: this.tasksRoot,
        task: context.task,
        taskSlug: context.task.slug,
        workspacePath: context.workspacePath,
        mainBranch: this.mainBranch,
        config: this.validators.architecture.config,
        orchestratorLog: this.orchestratorLog,
        logger: this.architectureLogger,
        paths: this.paths,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logOrchestratorEvent(this.orchestratorLog, "validator.error", {
        validator: ARCHITECTURE_VALIDATOR_ID,
        taskId: context.task.manifest.id,
        message: error,
      });
    } finally {
      this.onChecksetDuration?.(Date.now() - startedAt);
    }

    const summary = await summarizeArchitectureValidatorResult(reportPath, result, error);
    const normalized = this.buildValidationResult({
      validator: ARCHITECTURE_VALIDATOR_ID,
      status: summary.status,
      summary: summary.summary,
      reportPath: relativeReportPath(this.projectName, this.runId, summary.reportPath, this.paths),
      mode: this.validators.architecture.mode,
    });

    return { result: normalized, blocked: this.buildBlockResult(normalized) };
  }

  private buildValidationResult(input: ValidationResult): ValidationResult {
    return input;
  }

  private buildBlockResult(result: ValidationResult): ValidationBlock | null {
    if (!shouldBlockValidator(result.mode, result.status)) {
      return null;
    }

    return {
      ...result,
      reason: buildBlockReason(result.validator, result.summary),
    };
  }
}


// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

async function summarizeTestValidatorResult(
  reportPath: string,
  result: TestValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<TestValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeTestReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Test validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

async function summarizeStyleValidatorResult(
  reportPath: string,
  result: StyleValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<StyleValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeStyleReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Style validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}

async function summarizeArchitectureValidatorResult(
  reportPath: string,
  result: ArchitectureValidationReport | null,
  error?: string | null,
): Promise<ValidatorRunSummary> {
  const reportFromDisk = await readValidatorReport<ArchitectureValidationReport>(reportPath);
  const resolved = result ?? reportFromDisk;
  const status: ValidatorStatus =
    resolved === null ? "error" : resolved.pass ? "pass" : "fail";
  let summary: string | null = resolved ? summarizeArchitectureReport(resolved) : null;

  if (!summary && error) {
    summary = error;
  }
  if (!summary && status === "error") {
    summary = "Architecture validator returned no result (see validator log).";
  }

  const exists = resolved !== null || (await fse.pathExists(reportPath));
  return {
    status,
    summary,
    reportPath: exists ? reportPath : null,
  };
}


// =============================================================================
// FILE HELPERS
// =============================================================================

async function readValidatorReport<T>(reportPath: string): Promise<T | null> {
  const exists = await fse.pathExists(reportPath);
  if (!exists) return null;

  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const payload = (raw as { result?: unknown }).result;
  if (!payload || typeof payload !== "object") return null;

  return payload as T;
}

async function listValidatorReports(reportDir: string): Promise<string[]> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return [];

  const entries = await fse.readdir(reportDir);
  return entries.filter((name) => name.toLowerCase().endsWith(".json"));
}

async function findLatestReport(reportDir: string, before: string[]): Promise<string | null> {
  const exists = await fse.pathExists(reportDir);
  if (!exists) return null;

  const entries = (await fse.readdir(reportDir)).filter((name) => name.toLowerCase().endsWith(".json"));
  if (entries.length === 0) return null;

  const candidates = await Promise.all(
    entries.map(async (name) => {
      const fullPath = path.join(reportDir, name);
      const stat = await fse.stat(fullPath).catch(() => null);
      return { name, fullPath, mtimeMs: stat?.mtimeMs ?? 0, isNew: !before.includes(name) };
    }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates.find((c) => c.isNew) ?? candidates[0];
  return newest?.fullPath ?? null;
}


// =============================================================================
// RESULT HELPERS
// =============================================================================

function relativeReportPath(
  projectName: string,
  runId: string,
  reportPath: string | null,
  paths?: PathsContext,
): string | null {
  if (!reportPath) return null;

  const base = runLogsDir(projectName, runId, paths);
  const relative = path.relative(base, reportPath);
  return relative.startsWith("..") ? reportPath : relative;
}

function shouldBlockValidator(mode: ValidationResult["mode"], status: ValidatorStatus): boolean {
  if (mode !== "block") return false;
  return status === "fail" || status === "error";
}

function buildBlockReason(validator: ValidationResult["validator"], summary: string | null): string {
  const label = VALIDATOR_LABELS[validator] ?? "Validator";
  if (summary && summary.trim().length > 0) {
    return `${label} validator blocked merge: ${summary}`;
  }
  return `${label} validator blocked merge (mode=block)`;
}
