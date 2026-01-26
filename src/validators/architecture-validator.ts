import fg from "fast-glob";
import fse from "fs-extra";
import { z } from "zod";

import type { ArchitectureValidatorConfig } from "../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../core/logger.js";
import type { PathsContext } from "../core/paths.js";
import { taskBlastReportPath, validatorLogPath } from "../core/paths.js";
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
  normalizePath,
  secondsToMs,
} from "./lib/normalize.js";
import type { FileSample } from "./lib/types.js";

// =============================================================================
// TYPES
// =============================================================================
type ControlPlaneImpact = {
  touched_components: string[];
  impacted_components: string[];
  confidence?: string;
  widening_reasons: string[];
};

type ValidationContext = {
  taskSpec: string;
  architectureDocs: FileSample[];
  changedFiles: FileSample[];
  diffSummary: string;
  controlPlaneImpact: ControlPlaneImpact | null;
};

export type ArchitectureValidationReport = z.infer<typeof ArchitectureValidationSchema>;

export type ArchitectureValidatorArgs = {
  projectName: string;
  repoPath: string;
  runId: string;
  tasksRoot: string;
  task: TaskSpec;
  taskSlug: string;
  workspacePath: string;
  mainBranch: string;
  config?: ArchitectureValidatorConfig;
  orchestratorLog: JsonlLogger;
  logger?: JsonlLogger;
  llmClient?: LlmClient;
  paths?: PathsContext;
};

// =============================================================================
// CONSTANTS
// =============================================================================

export const VALIDATOR_NAME = "architecture-validator";
export const VALIDATOR_ID = "architecture";

const DOC_SNIPPET_LIMIT = 4_000;
const FILE_SNIPPET_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 4_000;
const DIFF_SUMMARY_LIMIT = 2_000;
const MAX_DOCS = 6;
const MAX_CHANGED_FILES = 12;

const ArchitectureValidationSchema = z
  .object({
    pass: z.boolean(),
    summary: z.string(),
    concerns: z
      .array(
        z
          .object({
            issue: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            evidence: z.string(),
            location: z.string().optional(),
            suggested_fix: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    recommendations: z
      .array(
        z
          .object({
            description: z.string(),
            impact: z.enum(["high", "medium", "low"]),
            action: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  })
  .strict();

const ArchitectureValidatorJsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
          location: { type: "string" },
          suggested_fix: { type: "string" },
        },
        required: ["issue", "severity", "evidence"],
        additionalProperties: false,
      },
      default: [],
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          action: { type: "string" },
        },
        required: ["description", "impact"],
        additionalProperties: false,
      },
      default: [],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["pass", "summary", "concerns", "recommendations", "confidence"],
  additionalProperties: false,
} as const;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function runArchitectureValidator(
  args: ArchitectureValidatorArgs,
): Promise<ArchitectureValidationReport | null> {
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
    const context = await buildValidationContext(args, cfg);

    if (context.changedFiles.length === 0) {
      const result: ArchitectureValidationReport = {
        pass: true,
        summary: "No changed files detected; validation skipped.",
        concerns: [],
        recommendations: [],
        confidence: "high",
      };

      await persistReport(args, cfg, context, result);
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

    if (context.architectureDocs.length === 0) {
      if (!cfg.fail_if_docs_missing) {
        const result: ArchitectureValidationReport = {
          pass: true,
          summary: "No architecture docs found; validation skipped.",
          concerns: [],
          recommendations: [],
          confidence: "high",
        };

        await persistReport(args, cfg, context, result);
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

      const result: ArchitectureValidationReport = {
        pass: false,
        summary: "No architecture docs found; validation failed.",
        concerns: [
          {
            issue: "Architecture docs missing for validation.",
            severity: "high",
            evidence: `No docs matched glob: ${cfg.docs_glob}`,
            location: cfg.docs_glob,
            suggested_fix: "Add architecture docs or update docs_glob.",
          },
        ],
        recommendations: [
          {
            description: "Add architecture docs or update docs_glob to point to them.",
            impact: "high",
            action: `Provide docs matching: ${cfg.docs_glob}`,
          },
        ],
        confidence: "high",
      };

      validatorLog.log({
        type: "validation.analysis",
        taskId: args.task.manifest.id,
        payload: {
          validator: VALIDATOR_ID,
          docs_checked: 0,
          files_checked: context.changedFiles.length,
          concerns: result.concerns.length,
          recommendations: result.recommendations.length,
          confidence: result.confidence,
        },
      });

      await persistReport(args, cfg, context, result);
      logOrchestratorEvent(args.orchestratorLog, "validator.fail", {
        validator: VALIDATOR_ID,
        taskId: args.task.manifest.id,
      });
      return result;
    }

    const prompt = await renderPromptTemplate("architecture-validator", {
      project_name: args.projectName,
      repo_path: args.repoPath,
      task_id: args.task.manifest.id,
      task_name: args.task.manifest.name,
      task_spec: context.taskSpec,
      architecture_docs: formatFilesForPrompt(context.architectureDocs),
      changed_files: formatFilesForPrompt(context.changedFiles),
      diff_summary: context.diffSummary,
      control_plane_impact: formatControlPlaneImpactForPrompt(context.controlPlaneImpact),
    });

    const client = args.llmClient ?? createValidatorClient(cfg);
    const completion = await client.complete<ArchitectureValidationReport>(prompt, {
      schema: ArchitectureValidatorJsonSchema,
      temperature: cfg.temperature ?? 0,
      timeoutMs: secondsToMs(cfg.timeout_seconds),
    });

    const result = normalizeCompletion(completion, ArchitectureValidationSchema, "Architecture");

    validatorLog.log({
      type: "validation.analysis",
      taskId: args.task.manifest.id,
      payload: {
        validator: VALIDATOR_ID,
        docs_checked: context.architectureDocs.length,
        files_checked: context.changedFiles.length,
        concerns: result.concerns.length,
        recommendations: result.recommendations.length,
        confidence: result.confidence,
        finish_reason: completion.finishReason,
      },
    });

    await persistReport(args, cfg, context, result, completion.finishReason);

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

async function buildValidationContext(
  args: ArchitectureValidatorArgs,
  cfg: ArchitectureValidatorConfig,
): Promise<ValidationContext> {
  const taskSpecPath = resolveTaskSpecPath({
    tasksRoot: args.tasksRoot,
    stage: args.task.stage,
    taskDirName: args.task.taskDirName,
  });
  const [taskSpec, diffSummary, changedFiles, architectureDocs, controlPlaneImpact] =
    await Promise.all([
      readTaskSpec(taskSpecPath, TASK_SPEC_LIMIT),
      readDiffSummary(args.workspacePath, args.mainBranch, DIFF_SUMMARY_LIMIT),
      readChangedFileSamples(args.workspacePath, args.mainBranch),
      readArchitectureDocs(args.repoPath, cfg.docs_glob),
      readControlPlaneImpact(args.repoPath, args.runId, args.task.manifest.id),
    ]);

  return {
    taskSpec,
    architectureDocs,
    changedFiles,
    diffSummary,
    controlPlaneImpact,
  };
}

async function persistReport(
  args: ArchitectureValidatorArgs,
  cfg: ArchitectureValidatorConfig,
  context: ValidationContext,
  result: ArchitectureValidationReport,
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
      docs_glob: cfg.docs_glob,
      fail_if_docs_missing: cfg.fail_if_docs_missing ?? false,
      docs: context.architectureDocs.map((f) => f.path),
      changed_files: context.changedFiles.map((f) => f.path),
      diff_summary: context.diffSummary,
      control_plane: context.controlPlaneImpact,
      finish_reason: finishReason ?? null,
    },
  });
}

async function readChangedFileSamples(
  workspacePath: string,
  mainBranch: string,
): Promise<FileSample[]> {
  const changedFiles = await listChangedFiles(workspacePath, mainBranch);
  return readFileSamples(workspacePath, changedFiles, FILE_SNIPPET_LIMIT, MAX_CHANGED_FILES);
}

async function readArchitectureDocs(repoPath: string, docsGlob: string): Promise<FileSample[]> {
  const matches = await fg(docsGlob, {
    cwd: repoPath,
    dot: true,
    onlyFiles: true,
  });
  const normalized = matches.map((docPath) => normalizePath(docPath)).sort();
  return readFileSamples(repoPath, normalized, DOC_SNIPPET_LIMIT, MAX_DOCS);
}

async function readControlPlaneImpact(
  repoPath: string,
  runId: string,
  taskId: string,
): Promise<ControlPlaneImpact | null> {
  const reportPath = taskBlastReportPath(repoPath, runId, taskId);
  const raw = await fse.readJson(reportPath).catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const touched = Array.isArray((raw as { touched_components?: unknown }).touched_components)
    ? ((raw as { touched_components?: string[] }).touched_components ?? [])
    : [];
  const impacted = Array.isArray((raw as { impacted_components?: unknown }).impacted_components)
    ? ((raw as { impacted_components?: string[] }).impacted_components ?? [])
    : [];
  const confidence =
    typeof (raw as { confidence?: unknown }).confidence === "string"
      ? (raw as { confidence?: string }).confidence
      : undefined;
  const widening = Array.isArray((raw as { widening_reasons?: unknown }).widening_reasons)
    ? ((raw as { widening_reasons?: string[] }).widening_reasons ?? [])
    : [];

  return {
    touched_components: touched,
    impacted_components: impacted,
    confidence,
    widening_reasons: widening,
  };
}

function formatControlPlaneImpactForPrompt(impact: ControlPlaneImpact | null): string {
  if (!impact) {
    return "Unavailable";
  }

  const touched =
    impact.touched_components.length > 0 ? impact.touched_components.join(", ") : "None";
  const impacted =
    impact.impacted_components.length > 0 ? impact.impacted_components.join(", ") : "None";
  const parts = [
    `Touched components (${impact.touched_components.length}): ${touched}`,
    `Impacted components (${impact.impacted_components.length}): ${impacted}`,
  ];

  if (impact.confidence) {
    parts.push(`Blast confidence: ${impact.confidence}`);
  }

  if (impact.widening_reasons.length > 0) {
    parts.push(`Widening reasons: ${impact.widening_reasons.join(", ")}`);
  }

  return parts.join("\n");
}
