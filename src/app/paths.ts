import {
  createPathsContext,
  resolveMyceliumHome,
  setDefaultPathsContext,
  type PathsContext,
} from "../core/paths.js";


// =============================================================================
// TYPES
// =============================================================================

export type AppPathsInput = {
  myceliumHome?: string;
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
};


// =============================================================================
// HELPERS
// =============================================================================

export function resolveMyceliumHomeFromEnv(input: AppPathsInput = {}): string {
  const envHome = input.env?.MYCELIUM_HOME ?? process.env.MYCELIUM_HOME;
  const override = input.myceliumHome ?? envHome;

  return resolveMyceliumHome({ myceliumHome: override, repoPath: input.repoPath });
}


// =============================================================================
// PUBLIC API
// =============================================================================

export function createAppPathsContext(input: AppPathsInput = {}): PathsContext {
  return createPathsContext({ myceliumHome: resolveMyceliumHomeFromEnv(input) });
}

export function setDefaultAppPathsContext(input: AppPathsInput = {}): PathsContext {
  const paths = createAppPathsContext(input);
  setDefaultPathsContext(paths);
  return paths;
}
