/**
 * loadAppContext resolves project config + paths for app entrypoints.
 * Purpose: centralize config discovery without mutating process.env.
 * Assumptions: config loader validates schema and resolves repo_path.
 * Usage: const { appContext } = await loadAppContext({ projectName }).
 */

import path from "node:path";

import { findRepoRoot, resolveProjectConfigPath } from "../../core/config-discovery.js";
import { loadProjectConfig } from "../../core/config-loader.js";
import { createAppContext, type AppContext } from "../context.js";
import { setDefaultAppPathsContext } from "../paths.js";


// =============================================================================
// TYPES
// =============================================================================

export type LoadAppContextArgs = {
  projectName?: string;
  explicitConfigPath?: string;
  initIfMissing?: boolean;
  cwd?: string;
  myceliumHome?: string;
};

export type LoadAppContextResult = {
  appContext: AppContext;
  created: boolean;
};


// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadAppContext(args: LoadAppContextArgs): Promise<LoadAppContextResult> {
  const cwd = args.cwd ?? process.cwd();
  let projectName = args.projectName;

  setDefaultAppPathsContext({ myceliumHome: args.myceliumHome });

  if (!projectName) {
    const repoRoot = findRepoRoot(cwd);
    if (repoRoot) {
      projectName = path.basename(repoRoot);
    } else if (args.explicitConfigPath) {
      const configDir = path.dirname(path.resolve(args.explicitConfigPath));
      const configRepo = findRepoRoot(configDir);
      if (configRepo) {
        projectName = path.basename(configRepo);
      }
    }
  }

  if (!projectName) {
    throw new Error(
      "Project name is required when no git repo is available. Pass --project or run inside a git repo.",
    );
  }

  const resolved = resolveProjectConfigPath({
    projectName,
    explicitPath: args.explicitConfigPath,
    cwd,
    initIfMissing: args.initIfMissing,
  });

  const config = loadProjectConfig(resolved.configPath);
  const appContext = createAppContext({
    projectName,
    configPath: resolved.configPath,
    config,
    myceliumHome: args.myceliumHome,
  });

  return { appContext, created: resolved.created };
}
