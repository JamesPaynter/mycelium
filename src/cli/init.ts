import { initRepoConfig, repoConfigPath } from "../core/config-discovery.js";

// =============================================================================
// INIT (repo-scoped scaffolding)
// =============================================================================

export async function initCommand(opts: {
  force?: boolean;
}): Promise<{ created: boolean; configPath: string }> {
  const result = initRepoConfig({ force: opts.force ?? false });

  if (result.status === "created") {
    console.log(`Created Mycelium config at ${result.configPath}`);
  } else if (result.status === "overwritten") {
    console.log(`Overwrote Mycelium config at ${result.configPath}`);
  } else {
    console.log(`Mycelium config already exists at ${result.configPath}`);
  }

  return { created: result.status !== "exists", configPath: result.configPath };
}

export { repoConfigPath };
