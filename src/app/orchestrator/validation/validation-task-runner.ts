import { logOrchestratorEvent } from "../../../core/logger.js";
import { validatorReportPath } from "../../../core/paths.js";
import {
  type ArchitectureValidationReport,
  VALIDATOR_ID as ARCHITECTURE_VALIDATOR_ID,
  VALIDATOR_NAME as ARCHITECTURE_VALIDATOR_NAME,
} from "../../../validators/architecture-validator.js";
import {
  type StyleValidationReport,
  VALIDATOR_ID as STYLE_VALIDATOR_ID,
  VALIDATOR_NAME as STYLE_VALIDATOR_NAME,
} from "../../../validators/style-validator.js";
import {
  type TestValidationReport,
  VALIDATOR_ID as TEST_VALIDATOR_ID,
  VALIDATOR_NAME as TEST_VALIDATOR_NAME,
} from "../../../validators/test-validator.js";

import type { ValidationOutcome, ValidationResult } from "./types.js";
import { buildBlockResult } from "./validation-blocks.js";
import {
  relativeReportPath,
  summarizeArchitectureValidatorResult,
  summarizeStyleValidatorResult,
  summarizeTestValidatorResult,
} from "./validation-helpers.js";
import type {
  ValidationRunnerContext,
  ValidationStepOutcome,
  ValidationTaskContext,
} from "./validation-runner-types.js";

export async function runTaskValidation(
  context: ValidationRunnerContext,
  taskContext: ValidationTaskContext,
): Promise<ValidationOutcome> {
  const results: ValidationResult[] = [];
  const blocked: ValidationOutcome["blocked"] = [];

  if (context.validators.test.enabled && context.validators.test.config) {
    const outcome = await runTestValidation(context, taskContext);
    results.push(outcome.result);
    if (outcome.blocked) blocked.push(outcome.blocked);
  }

  if (context.validators.style.enabled && context.validators.style.config) {
    const outcome = await runStyleValidation(context, taskContext);
    results.push(outcome.result);
    if (outcome.blocked) blocked.push(outcome.blocked);
  }

  if (context.validators.architecture.enabled && context.validators.architecture.config) {
    const outcome = await runArchitectureValidation(context, taskContext);
    results.push(outcome.result);
    if (outcome.blocked) blocked.push(outcome.blocked);
  }

  return {
    taskId: taskContext.task.manifest.id,
    results,
    blocked,
  };
}

export async function runTestValidation(
  context: ValidationRunnerContext,
  taskContext: ValidationTaskContext,
): Promise<ValidationStepOutcome> {
  const reportPath = validatorReportPath(
    context.projectName,
    context.runId,
    TEST_VALIDATOR_NAME,
    taskContext.task.manifest.id,
    taskContext.task.slug,
    context.paths,
  );

  let result: TestValidationReport | null = null;
  let error: string | null = null;
  const startedAt = Date.now();
  try {
    result = await context.runner.runTestValidator({
      projectName: context.projectName,
      repoPath: context.repoPath,
      runId: context.runId,
      tasksRoot: context.tasksRoot,
      task: taskContext.task,
      taskSlug: taskContext.task.slug,
      workspacePath: taskContext.workspacePath,
      taskLogsDir: taskContext.logsDir,
      mainBranch: context.mainBranch,
      config: context.validators.test.config,
      orchestratorLog: context.orchestratorLog,
      logger: context.loggers.test,
      paths: context.paths,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logOrchestratorEvent(context.orchestratorLog, "validator.error", {
      validator: TEST_VALIDATOR_ID,
      taskId: taskContext.task.manifest.id,
      message: error,
    });
  } finally {
    context.onChecksetDuration?.(Date.now() - startedAt);
  }

  const summary = await summarizeTestValidatorResult(reportPath, result, error);
  const normalized = buildValidationResult({
    validator: TEST_VALIDATOR_ID,
    status: summary.status,
    summary: summary.summary,
    reportPath: relativeReportPath(
      context.projectName,
      context.runId,
      summary.reportPath,
      context.paths,
    ),
    mode: context.validators.test.mode,
  });

  return { result: normalized, blocked: buildBlockResult(normalized) };
}

export async function runStyleValidation(
  context: ValidationRunnerContext,
  taskContext: ValidationTaskContext,
): Promise<ValidationStepOutcome> {
  const reportPath = validatorReportPath(
    context.projectName,
    context.runId,
    STYLE_VALIDATOR_NAME,
    taskContext.task.manifest.id,
    taskContext.task.slug,
    context.paths,
  );

  let result: StyleValidationReport | null = null;
  let error: string | null = null;
  const startedAt = Date.now();
  try {
    result = await context.runner.runStyleValidator({
      projectName: context.projectName,
      repoPath: context.repoPath,
      runId: context.runId,
      tasksRoot: context.tasksRoot,
      task: taskContext.task,
      taskSlug: taskContext.task.slug,
      workspacePath: taskContext.workspacePath,
      mainBranch: context.mainBranch,
      config: context.validators.style.config,
      orchestratorLog: context.orchestratorLog,
      logger: context.loggers.style,
      paths: context.paths,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logOrchestratorEvent(context.orchestratorLog, "validator.error", {
      validator: STYLE_VALIDATOR_ID,
      taskId: taskContext.task.manifest.id,
      message: error,
    });
  } finally {
    context.onChecksetDuration?.(Date.now() - startedAt);
  }

  const summary = await summarizeStyleValidatorResult(reportPath, result, error);
  const normalized = buildValidationResult({
    validator: STYLE_VALIDATOR_ID,
    status: summary.status,
    summary: summary.summary,
    reportPath: relativeReportPath(
      context.projectName,
      context.runId,
      summary.reportPath,
      context.paths,
    ),
    mode: context.validators.style.mode,
  });

  return { result: normalized, blocked: buildBlockResult(normalized) };
}

export async function runArchitectureValidation(
  context: ValidationRunnerContext,
  taskContext: ValidationTaskContext,
): Promise<ValidationStepOutcome> {
  const reportPath = validatorReportPath(
    context.projectName,
    context.runId,
    ARCHITECTURE_VALIDATOR_NAME,
    taskContext.task.manifest.id,
    taskContext.task.slug,
    context.paths,
  );

  let result: ArchitectureValidationReport | null = null;
  let error: string | null = null;
  const startedAt = Date.now();
  try {
    result = await context.runner.runArchitectureValidator({
      projectName: context.projectName,
      repoPath: context.repoPath,
      runId: context.runId,
      tasksRoot: context.tasksRoot,
      task: taskContext.task,
      taskSlug: taskContext.task.slug,
      workspacePath: taskContext.workspacePath,
      mainBranch: context.mainBranch,
      config: context.validators.architecture.config,
      orchestratorLog: context.orchestratorLog,
      logger: context.loggers.architecture,
      paths: context.paths,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logOrchestratorEvent(context.orchestratorLog, "validator.error", {
      validator: ARCHITECTURE_VALIDATOR_ID,
      taskId: taskContext.task.manifest.id,
      message: error,
    });
  } finally {
    context.onChecksetDuration?.(Date.now() - startedAt);
  }

  const summary = await summarizeArchitectureValidatorResult(reportPath, result, error);
  const normalized = buildValidationResult({
    validator: ARCHITECTURE_VALIDATOR_ID,
    status: summary.status,
    summary: summary.summary,
    reportPath: relativeReportPath(
      context.projectName,
      context.runId,
      summary.reportPath,
      context.paths,
    ),
    mode: context.validators.architecture.mode,
  });

  return { result: normalized, blocked: buildBlockResult(normalized) };
}

function buildValidationResult(input: ValidationResult): ValidationResult {
  return input;
}
