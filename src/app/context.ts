/**
 * AppContext resolves repo-scoped config + paths without mutating globals.
 * Purpose: make repo + MYCELIUM_HOME explicit for CLI/UI/core consumers.
 * Assumptions: config has already been validated by the loader.
 * Usage: const ctx = createAppContext({ projectName, configPath, config }).
 */

import path from "node:path";

import type { ProjectConfig } from "../core/config.js";
import { createPathsContext, resolveMyceliumHome, type PathsContext } from "../core/paths.js";


// =============================================================================
// TYPES
// =============================================================================

export type AppContext = {
  projectName: string;
  configPath: string;
  config: ProjectConfig;
  repoPath: string;
  myceliumHome: string;
  paths: PathsContext;
};

export type CreateAppContextInput = {
  projectName: string;
  configPath: string;
  config: ProjectConfig;
  myceliumHome?: string;
};


// =============================================================================
// PUBLIC API
// =============================================================================

export function createAppContext(input: CreateAppContextInput): AppContext {
  const repoPath = path.resolve(input.config.repo_path);
  const myceliumHome = resolveMyceliumHome({
    repoPath,
    myceliumHome: input.myceliumHome,
  });

  return {
    projectName: input.projectName,
    configPath: path.resolve(input.configPath),
    config: input.config,
    repoPath,
    myceliumHome,
    paths: createPathsContext({ myceliumHome }),
  };
}
