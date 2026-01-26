import path from "node:path";

import { Command } from "commander";

import { resolveOwnershipForPath } from "../../../control-plane/extract/ownership.js";

import type { ControlPlaneCommandContext } from "./index.js";



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerComponentsCommands(
  controlPlane: Command,
  ctx: ControlPlaneCommandContext,
): void {
  const components = controlPlane
    .command("components")
    .description("Component catalog queries");

  components
    .command("list")
    .description("List known components")
    .action(async (...args) => {
      await handleComponentsList(ctx, resolveCommandFromArgs(args));
    });

  components
    .command("show")
    .description("Show component details")
    .argument("<id>", "Component id")
    .action(async (id, ...rest) => {
      await handleComponentsShow(ctx, String(id), resolveCommandFromArgs(rest));
    });

  controlPlane
    .command("owner")
    .description("Show owning component for a path")
    .argument("<path>", "Path to inspect")
    .action(async (targetPath, ...rest) => {
      await handleOwnerLookup(ctx, String(targetPath), resolveCommandFromArgs(rest));
    });
}



// =============================================================================
// COMMANDS
// =============================================================================

async function handleComponentsList(
  ctx: ControlPlaneCommandContext,
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

    ctx.emitControlPlaneResult(modelResult.model.components, output);
  } catch (error) {
    ctx.emitControlPlaneError(ctx.resolveModelStoreError(error), output);
  }
}

async function handleComponentsShow(
  ctx: ControlPlaneCommandContext,
  componentId: string,
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

    const component =
      modelResult.model.components.find((entry) => entry.id === componentId) ?? null;

    ctx.emitControlPlaneResult(component, output);
  } catch (error) {
    ctx.emitControlPlaneError(ctx.resolveModelStoreError(error), output);
  }
}

async function handleOwnerLookup(
  ctx: ControlPlaneCommandContext,
  targetPath: string,
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

    const repoRelativePath = resolveRepoRelativePath(flags.repoPath, targetPath);
    const result = resolveOwnershipForPath(
      modelResult.model.ownership,
      modelResult.model.components,
      repoRelativePath,
    );

    ctx.emitControlPlaneResult(result, output);
  } catch (error) {
    ctx.emitControlPlaneError(ctx.resolveModelStoreError(error), output);
  }
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function resolveCommandFromArgs(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}

function resolveRepoRelativePath(repoRoot: string, targetPath: string): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(resolvedRepoRoot, targetPath);
  return path.relative(resolvedRepoRoot, resolvedTarget);
}
