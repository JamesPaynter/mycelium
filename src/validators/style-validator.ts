import { z } from "zod";

import type { ValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import type { PathsContext } from "../core/paths.js";
import { validatorLogPath } from "../core/paths.js";
import { renderPromptTemplate } from "../core/prompts.js";
import { resolveTaskSpecPath } from "../core/task-layout.js";
import type { TaskSpec } from "../core/task-manifest.js";
import { listChangedFiles } from "../git/changes.js";
import type { LlmClient } from "../llm/client.js";

import { createValidatorClient } from "./lib/client.js";
import {
  readDiffSummary,
  readFileSamples,
  readTaskSpec,
  writeTaskValidatorReport,
} from "./lib/io.js";
import {
  formatError,
  formatFilesForPrompt,
  normalizeCompletion,
  secondsToMs,
} from "./lib/normalize.js";
import type { FileSample } from "./lib/types.js";

// =============================================================================
// TYPES
// =============================================================================
type ValidationContext = {
  taskSpec: string;
  changedFiles: FileSample[];
  diffSummary: string;
};

export type StyleValidationReport = z.infer<typeof StyleValidationSchema>;

export type StyleValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  task: TaskSpec;
  taskSlug: string;
  workspacePath: string;
  mainBranch: string;
  config?: ValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
  paths?: PathsContext;
};

// =============================================================================
// CONSTANTS
// =============================================================================

export const VALIDATOR_NAME = "style-validator";
export const VALIDATOR_ID = "style";

const StyleValidationSchema = z
  .object({
    pass: z.boolean(),
    summary: z.string(),
    concerns: z
      .array(
        z
          .object({
            file: z.string(),
            line: z.number().int().nonnegative().optional(),
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            suggested_fix: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  })
  .strict();

const StyleValidatorJsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggested_fix: { type: "string" },
        },
        required: ["file", "issue", "severity"],
        additionalProperties: false,
      },
      default: [],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["pass", "summary", "concerns", "confidence"],
  additionalProperties: false,
} as const;

const FILE_SNIPPET_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 4_000;
const DIFF_SUMMARY_LIMIT = 2_000;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runStyleValidator(
  args: StyleValidatorArgs,
): Promise<StyleValidationReport | null> {
  const cfg = args.config;
  if (!cfg || cfg.enabled === false) {
    return null;
  }

  const validatorLog =
    args.logger ??
    new JsonlLogger(validatorLogPath(args.projectName, args.runId, VALIDATOR_NAME, args.paths), {
      runId: args.runId,
    });
  const shouldCloseLog = !args.logger;

  logOrchestratorEvent(args.orchestratorLog, "validator.start", {
    validator: VALIDATOR_ID,
    taskId: args.task.manifest.id,
  });
  validatorLog.log({
    type: "validation.start",
    taskId: args.task.manifest.id,
    payload: { validator: VALIDATOR_ID },
  });

  try {
    const context = await buildValidationContext(args);

    if (context.changedFiles.length === 0) {
      const result: StyleValidationReport = {
        pass: true,
        summary: "No changed files detected; validation skipped.",
        concerns: [],
        confidence: "high",
      };

      await persistReport(args, context, result);
      validatorLog.log({
        type: "validation.skip",
        taskId: args.task.manifest.id,
        payload: { validator: VALIDATOR_ID },
      });
      logOrchestratorEvent(args.orchestratorLog, "validator.skip", {
        validator: VALIDATOR_ID,
        taskId: args.task.manifest.id,
      });
      return result;
    }

    const prompt = await renderPromptTemplate("style-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      task_id: args.task.manifest.id,
      task_name: args.task.manifest.name,
      task_spec: context.taskSpec,
      changed_files: formatFilesForPrompt(context.changedFiles),
      diff_summary: context.diffSummary,
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<StyleValidationReport>(prompt, {
      schema: StyleValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion, StyleValidationSchema, "Style");

    validatorLog.log({
      type: "validation.analysis",
      taskId: args.task.manifest.id,
      payload: {
        validator: VALIDATOR_ID,
        files_checked: context.changedFiles.length,
        concerns: result.concerns.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport(args, context, result, completion.finishReason);

    logOrchestratorEvent(args.orchestratorLog, result.pass ? "validator.pass" : "validator.fail", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
    });

    return result;
  } catch (err) {
    const message = formatError(err);
    validatorLog.log({
      type: "validation.error",
      taskId: args.task.manifest.id,
      payload: { validator: VALIDATOR_ID, message },
    });
    logOrchestratorEvent(args.orchestratorLog, "validator.error", {
      validator: VALIDATOR_ID,
      taskId: args.task.manifest.id,
      message,
    });
    return null;
  } finally {
    if (shouldCloseLog) {
      validatorLog.close();
    }
  }
}

// =============================================================================
// INTERNALS
// =============================================================================

async function buildValidationContext(args: StyleValidatorArgs): Promise<ValidationContext> {
  const changedFiles = await listChangedFiles(args.workspacePath, args.mainBranch);

  const taskSpecPath = resolveTaskSpecPath({
    tasksRoot: args.tasksRoot,
    stage: args.task.stage,
    taskDirName: args.task.taskDirName,
  });
  const [taskSpec, diffSummary, fileSamples] = await Promise.all([
    readTaskSpec(taskSpecPath, TASK_SPEC_LIMIT),
    readDiffSummary(args.workspacePath, args.mainBranch, DIFF_SUMMARY_LIMIT),
    readFileSamples(args.workspacePath, changedFiles, FILE_SNIPPET_LIMIT),
  ]);

  return {
    taskSpec,
    changedFiles: fileSamples,
    diffSummary,
  };
}

async function persistReport(
  args: StyleValidatorArgs,
  context: ValidationContext,
  result: StyleValidationReport,
  finishReason?: string | null,
): Promise<void> {
  await writeTaskValidatorReport({
    projectName: args.projectName,
    runId: args.runId,
    validatorName: VALIDATOR_NAME,
    validatorId: VALIDATOR_ID,
    taskId: args.task.manifest.id,
    taskName: args.task.manifest.name,
    taskSlug: args.taskSlug,
    paths: args.paths,
    result,
    meta: {
      finish_reason: finishReason ?? null,
      changed_files: context.changedFiles.map((f) => f.path),
      diff_summary: context.diffSummary,
    },
  });
}
