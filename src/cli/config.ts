import type { AppContext } from "../app/context.js";
import { loadAppContext } from "../app/config/load-app-context.js";
import type { ProjectConfig } from "../core/config.js";

// =============================================================================
// CONFIG DISCOVERY (CLI)
//
// Goals:
// - provide deterministic, low-friction config resolution
// - allow both repo-scoped configs and global per-project configs
// - optionally auto-scaffold a repo config to remove "first-run" friction
// =============================================================================

export type LoadConfigForCliArgs = {
  projectName?: string;
  explicitConfigPath?: string;
  initIfMissing?: boolean;
  cwd?: string;
};

export async function loadConfigForCli(args: LoadConfigForCliArgs): Promise<{
  appContext: AppContext;
  config: ProjectConfig;
  configPath: string;
  created: boolean;
  projectName: string;
}> {
  const { appContext, created } = await loadAppContext({
    projectName: args.projectName,
    explicitConfigPath: args.explicitConfigPath,
    initIfMissing: args.initIfMissing,
    cwd: args.cwd,
  });

  return {
    appContext,
    config: appContext.config,
    configPath: appContext.configPath,
    created,
    projectName: appContext.projectName,
  };
}
