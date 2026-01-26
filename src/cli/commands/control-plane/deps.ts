import { Command } from "commander";

import {
  resolveComponentDependencies,
  resolveComponentReverseDependencies,
} from "../../../control-plane/model/deps.js";

import type { ControlPlaneCommandContext } from "./index.js";

// =============================================================================
// TYPES
// =============================================================================

type DependencyQueryOptions = {
  transitive?: boolean;
  limit?: number;
};

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerDependencyCommands(
  controlPlane: Command,
  ctx: ControlPlaneCommandContext,
): void {
  controlPlane
    .command("deps")
    .description("Show dependencies for a component")
    .argument("<component>", "Component id")
    .option("--transitive", "Include transitive dependencies", false)
    .option("--limit <n>", "Limit number of edges", (value) => parseInt(value, 10))
    .action(async (componentId, opts, command) => {
      await handleDependencyQuery(
        ctx,
        String(componentId),
        "deps",
        opts as DependencyQueryOptions,
        command,
      );
    });

  controlPlane
    .command("rdeps")
    .description("Show reverse dependencies for a component")
    .argument("<component>", "Component id")
    .option("--transitive", "Include transitive dependencies", false)
    .option("--limit <n>", "Limit number of edges", (value) => parseInt(value, 10))
    .action(async (componentId, opts, command) => {
      await handleDependencyQuery(
        ctx,
        String(componentId),
        "rdeps",
        opts as DependencyQueryOptions,
        command,
      );
    });
}

// =============================================================================
// COMMANDS
// =============================================================================

async function handleDependencyQuery(
  ctx: ControlPlaneCommandContext,
  componentId: string,
  direction: "deps" | "rdeps",
  options: DependencyQueryOptions,
  command: Command,
): Promise<void> {
  const { flags, output } = ctx.resolveCommandContext(command);

  try {
    const modelResult = await ctx.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      ctx.emitModelNotBuiltError(ctx.modelNotBuiltMessage, output);
      return;
    }

    const query =
      direction === "deps" ? resolveComponentDependencies : resolveComponentReverseDependencies;
    const result = query({
      componentId,
      edges: modelResult.model.deps.edges,
      transitive: options.transitive ?? false,
      limit: options.limit ?? null,
    });

    ctx.emitControlPlaneResult(result, output);
  } catch (error) {
    ctx.emitControlPlaneError(ctx.resolveModelStoreError(error), output);
  }
}
