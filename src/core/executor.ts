import type { RunOptions, RunResult } from "../app/orchestrator/run/run-engine.js";
import { buildRunContext } from "../app/orchestrator/run-context-builder.js";
import { runEngine, runLegacyEngine } from "../app/orchestrator/run-engine.js";
import { createAppPathsContext } from "../app/paths.js";

import type { ProjectConfig } from "./config.js";
import { getDefaultPathsContext, setDefaultPathsContext, type PathsContext } from "./paths.js";

export { checkpointListsEqual, mergeCheckpointCommits } from "../app/orchestrator/run/task-engine.js";
export type { BatchPlanEntry, RunOptions, RunResult } from "../app/orchestrator/run/run-engine.js";


// =============================================================================
// PUBLIC API
// =============================================================================

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
  paths?: PathsContext,
): Promise<RunResult> {
  const resolvedPaths = resolveRunPaths(config, paths);
  const context = await buildRunContext({
    projectName,
    config,
    options: opts,
    paths: resolvedPaths,
    legacy: { runProject: runProjectLegacy },
  });

  return runEngine(context);
}


// =============================================================================
// LEGACY FALLBACK
// =============================================================================

async function runProjectLegacy(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
  paths?: PathsContext,
): Promise<RunResult> {
  const resolvedPaths = resolveRunPaths(config, paths);
  const context = await buildRunContext({
    projectName,
    config,
    options: opts,
    paths: resolvedPaths,
    legacy: { runProject: runProjectLegacy },
  });

  return runLegacyEngine(context);
}

function resolveRunPaths(config: ProjectConfig, paths?: PathsContext): PathsContext {
  const resolved =
    paths ?? getDefaultPathsContext() ?? createAppPathsContext({ repoPath: config.repo_path });
  setDefaultPathsContext(resolved);
  return resolved;
}
