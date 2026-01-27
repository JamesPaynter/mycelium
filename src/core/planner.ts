import path from "node:path";

import { AnthropicClient } from "../llm/anthropic.js";
import type { LlmClient } from "../llm/client.js";
import { isMockLlmEnabled, MockLlmClient } from "../llm/mock.js";
import { OpenAiClient } from "../llm/openai.js";

import type { PlannerConfig, ProjectConfig } from "./config.js";
import { JsonlLogger } from "./logger.js";
import type { PathsContext } from "./paths.js";
import { plannerHomeDir } from "./paths.js";
import { createCodexPlannerClient } from "./planner-codex-client.js";
import {
  PlannerOutputJsonSchema,
  type PlannerOutput,
  formatError,
  formatResources,
  parsePlannerOutput,
  readCodebaseTree,
  readImplementationPlan,
  secondsToMs,
} from "./planner-helpers.js";
import { renderPromptTemplate } from "./prompts.js";
import type { TaskWithSpec } from "./task-manifest.js";
import { writeTasksToDirectory } from "./task-writer.js";
export type PlanResult = {
  tasks: TaskWithSpec[];
  outputDir: string;
  planIndexPath?: string;
};

export async function planFromImplementationPlan(args: {
  projectName: string;
  config: ProjectConfig;
  inputPath: string;
  outputDir: string;
  dryRun?: boolean;
  log?: JsonlLogger;
  paths?: PathsContext;
}): Promise<PlanResult> {
  const { projectName, config, outputDir, dryRun } = args;
  const repoPath = config.repo_path;
  const outputDirAbs = path.isAbsolute(outputDir) ? outputDir : path.join(repoPath, outputDir);
  const inputAbs = path.isAbsolute(args.inputPath)
    ? args.inputPath
    : path.join(repoPath, args.inputPath);
  const log = args.log;

  try {
    const implementationPlan = await readImplementationPlan(inputAbs);
    const codebaseTree = await readCodebaseTree(repoPath);
    const resourcesBlock = formatResources(config.resources);

    const prompt = await renderPromptTemplate("planner", {
      project_name: projectName,
      repo_path: repoPath,
      resources: resourcesBlock,
      doctor_command: config.doctor,
      lint_command: config.lint ?? "",
      implementation_plan: implementationPlan,
      codebase_tree: codebaseTree,
    });

    log?.log({ type: "planner.start", payload: { project: projectName, input: inputAbs } });

    const client = createPlannerClient(config.planner, projectName, repoPath, log, args.paths);
    const completion = await client.complete<PlannerOutput>(prompt, {
      schema: PlannerOutputJsonSchema,
      temperature: config.planner.temperature,
      timeoutMs: secondsToMs(config.planner.timeout_seconds),
    });

    log?.log({ type: "planner.llm.complete", payload: { finish_reason: completion.finishReason } });

    const tasks = parsePlannerOutput(
      completion,
      config.resources.map((r) => r.name),
    );

    log?.log({ type: "planner.validate.complete", payload: { task_count: tasks.length } });

    if (dryRun) {
      return { tasks, outputDir: outputDirAbs };
    }

    const writeResult = await writeTasksToDirectory({
      tasks,
      outputDir: outputDirAbs,
      project: projectName,
      inputPath: inputAbs,
    });

    log?.log({
      type: "planner.write.complete",
      payload: { task_count: tasks.length, output_dir: outputDirAbs },
    });

    return {
      tasks,
      outputDir: outputDirAbs,
      planIndexPath: writeResult.planIndexPath,
    };
  } catch (err) {
    log?.log({ type: "planner.error", payload: { message: formatError(err) } });
    throw err;
  }
}

export function createPlannerClient(
  cfg: PlannerConfig,
  projectName: string,
  repoPath: string,
  log?: JsonlLogger,
  paths?: PathsContext,
): LlmClient {
  if (isMockLlmEnabled() || cfg.provider === "mock") {
    return new MockLlmClient();
  }

  if (cfg.provider === "openai") {
    return new OpenAiClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
    });
  }

  if (cfg.provider === "anthropic") {
    return new AnthropicClient({
      model: cfg.model,
      defaultTemperature: cfg.temperature,
      defaultTimeoutMs: secondsToMs(cfg.timeout_seconds),
      apiKey: cfg.anthropic_api_key,
      baseURL: cfg.anthropic_base_url,
    });
  }

  if (cfg.provider === "codex") {
    const codexHome = plannerHomeDir(projectName, paths);
    return createCodexPlannerClient({
      model: cfg.model,
      codexHome,
      workingDirectory: repoPath,
      log,
    });
  }

  throw new Error(`Unsupported planner provider: ${cfg.provider}`);
}
