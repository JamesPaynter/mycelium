/**
 * ValidationPipeline centralizes validator execution and normalization.
 * Purpose: run validators, normalize outputs, and surface block reasons for the executor.
 * Assumptions: validators write their own reports; pipeline reads reports for summaries.
 * Usage: const pipeline = new ValidationPipeline(options); await pipeline.runForTask(ctx).
 */

import type { ProjectConfig } from "../../../core/config.js";
import { JsonlLogger } from "../../../core/logger.js";
import type { PathsContext } from "../../../core/paths.js";
import { validatorLogPath } from "../../../core/paths.js";
import { VALIDATOR_NAME as ARCHITECTURE_VALIDATOR_NAME } from "../../../validators/architecture-validator.js";
import { VALIDATOR_NAME as DOCTOR_VALIDATOR_NAME } from "../../../validators/doctor-validator.js";
import { VALIDATOR_NAME as STYLE_VALIDATOR_NAME } from "../../../validators/style-validator.js";
import { VALIDATOR_NAME as TEST_VALIDATOR_NAME } from "../../../validators/test-validator.js";
import type { ValidatorRunner } from "../ports.js";
import type { RunValidatorConfig } from "../run-context.js";

import type { DoctorValidationOutcome, ValidationOutcome } from "./types.js";
import {
  DEFAULT_RUNNER,
  runDoctorValidation,
  runTaskValidation,
  type DoctorValidationContext,
  type ValidationRunnerContext,
  type ValidationTaskContext,
} from "./validation-runner.js";

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

type ValidationRunnerLoggers = ValidationRunnerContext["loggers"];

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
    return runTaskValidation(this.buildRunnerContext(), context);
  }

  async runDoctorValidation(
    context: DoctorValidationContext,
  ): Promise<DoctorValidationOutcome | null> {
    return runDoctorValidation(this.buildRunnerContext(), context);
  }

  private buildRunnerContext(): ValidationRunnerContext {
    const loggers: ValidationRunnerLoggers = {
      test: this.testLogger,
      style: this.styleLogger,
      architecture: this.architectureLogger,
      doctor: this.doctorLogger,
    };

    return {
      projectName: this.projectName,
      repoPath: this.repoPath,
      runId: this.runId,
      tasksRoot: this.tasksRoot,
      mainBranch: this.mainBranch,
      paths: this.paths,
      validators: this.validators,
      orchestratorLog: this.orchestratorLog,
      runner: this.runner,
      loggers,
      onChecksetDuration: this.onChecksetDuration,
      onDoctorDuration: this.onDoctorDuration,
    };
  }
}
