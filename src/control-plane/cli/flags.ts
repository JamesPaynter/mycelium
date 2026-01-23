import type { Command } from "commander";

export type ControlPlaneRevisionRequest = {
  baseSha: string | null;
  ref: string | null;
  source: "base-sha" | "ref" | "explicit-both" | "default";
};

export type ControlPlaneFlagOptions = {
  repoPath: string;
  revision: ControlPlaneRevisionRequest;
  shouldBuild: boolean;
  useJson: boolean;
  prettyJson: boolean;
};



// =============================================================================
// FLAG REGISTRATION
// =============================================================================

export function registerControlPlaneFlags(command: Command): void {
  command
    .option("--repo <path>", "Repo path to index (default: current working directory)")
    .option("--base-sha <sha>", "Base commit SHA for comparisons (overrides --ref)")
    .option("--ref <ref>", "Git ref for comparisons (resolved to a base SHA later)")
    .option("--json", "Emit JSON output envelope", false)
    .option("--pretty", "Pretty-print JSON output", false)
    .option("--no-build", "Fail fast if the navigation model is missing");
}



// =============================================================================
// FLAG RESOLUTION
// =============================================================================

export function resolveControlPlaneFlags(command: Command): ControlPlaneFlagOptions {
  const opts = command.optsWithGlobals() as {
    repo?: string;
    baseSha?: string;
    ref?: string;
    json?: boolean;
    pretty?: boolean;
    build?: boolean;
  };

  const baseSha = opts.baseSha ?? null;
  const ref = opts.ref ?? null;
  const prettyJson = opts.pretty ?? false;
  const useJson = (opts.json ?? false) || prettyJson;

  return {
    repoPath: opts.repo ?? process.cwd(),
    revision: resolveControlPlaneRevision({ baseSha, ref }),
    shouldBuild: opts.build ?? true,
    useJson,
    prettyJson,
  };
}



// =============================================================================
// REVISION CONTRACT
// =============================================================================

export function resolveControlPlaneRevision(input: {
  baseSha: string | null;
  ref: string | null;
}): ControlPlaneRevisionRequest {
  if (input.baseSha && input.ref) {
    return { baseSha: input.baseSha, ref: input.ref, source: "explicit-both" };
  }

  if (input.baseSha) {
    return { baseSha: input.baseSha, ref: null, source: "base-sha" };
  }

  if (input.ref) {
    return { baseSha: null, ref: input.ref, source: "ref" };
  }

  return { baseSha: null, ref: null, source: "default" };
}
