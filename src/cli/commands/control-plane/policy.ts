import { Command } from "commander";

import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";

import {
  buildPolicyEvalOutput,
  type PolicyEvalOptions,
  resolvePolicyEvalError,
} from "./policy-eval-helpers.js";

import type { ControlPlaneCommandContext } from "./index.js";

// =============================================================================
// POLICY EVAL COMMANDS
// =============================================================================

export function registerPolicyCommands(
  controlGraph: Command,
  sharedContext: ControlPlaneCommandContext,
): void {
  const policy = controlGraph.command("policy").description("Policy evaluation queries");

  policy
    .command("eval")
    .description("Evaluate policy decisions for a change set")
    .option("--changed <paths...>", "Paths to treat as changed")
    .option("--diff <range>", "Git diff rev range (e.g., HEAD~1..HEAD)")
    .option("--against <ref>", "Git ref to diff against HEAD")
    .option("--manifest <path>", "Task manifest JSON to evaluate")
    .action(async (opts, command) => {
      await handlePolicyEval(opts as PolicyEvalOptions, command, sharedContext);
    });
}

async function handlePolicyEval(
  options: PolicyEvalOptions,
  command: Command,
  sharedContext: ControlPlaneCommandContext,
): Promise<void> {
  const { flags, output } = sharedContext.resolveCommandContext(command);

  let modelResult: { model: ControlPlaneModel; baseSha: string } | null = null;
  try {
    modelResult = await sharedContext.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });
  } catch (error) {
    sharedContext.emitControlPlaneError(sharedContext.resolveModelStoreError(error), output);
    return;
  }

  if (!modelResult) {
    sharedContext.emitModelNotBuiltError(sharedContext.modelNotBuiltMessage, output);
    return;
  }

  try {
    const result = await buildPolicyEvalOutput({
      repoPath: flags.repoPath,
      baseSha: modelResult.baseSha,
      model: modelResult.model,
      options,
      configPath: resolveGlobalConfigPath(command),
    });
    sharedContext.emitControlPlaneResult(result, output);
  } catch (error) {
    sharedContext.emitControlPlaneError(resolvePolicyEvalError(error), output);
  }
}

function resolveGlobalConfigPath(command: Command): string | null {
  const globals = command.optsWithGlobals() as { config?: string };
  return globals.config ? String(globals.config) : null;
}
