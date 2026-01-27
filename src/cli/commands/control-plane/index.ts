import { Command } from "commander";

import {
  registerControlPlaneFlags,
  resolveControlPlaneFlags,
  type ControlPlaneFlagOptions,
} from "../../../control-plane/cli/flags.js";
import type {
  ControlPlaneJsonError,
  ControlPlaneOutputOptions,
} from "../../../control-plane/cli/output.js";
import {
  CONTROL_PLANE_ERROR_CODES,
  emitControlPlaneError,
  emitControlPlaneResult,
  emitModelNotBuiltError,
} from "../../../control-plane/cli/output.js";
import {
  buildControlPlaneModel,
  getControlPlaneModelInfo,
} from "../../../control-plane/model/build.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import { ControlPlaneBuildLockError, ControlPlaneStore } from "../../../control-plane/storage.js";

import { registerBlastRadiusCommand } from "./blast-radius.js";
import { registerComponentsCommands } from "./components.js";
import { registerDependencyCommands } from "./deps.js";
import { registerPolicyCommands } from "./policy.js";
import { registerSearchCommand } from "./search.js";
import { registerSymbolCommands } from "./symbols.js";

const MODEL_NOT_BUILT_MESSAGE =
  "Control graph model not built. Run `mycelium cg build` to generate it.";
const CONTROL_PLANE_DEPRECATION_WARNING = "deprecated: use `mycelium cg` (control graph).";
const DEPRECATED_CONTROL_PLANE_ALIASES = new Set(["cp", "control-plane"]);

// =============================================================================
// TYPES
// =============================================================================

type ControlPlaneCommandRuntimeContext = {
  flags: ControlPlaneFlagOptions;
  output: ControlPlaneOutputOptions;
};

export type ControlPlaneCommandContext = {
  modelNotBuiltMessage: string;
  resolveCommandContext: (command: Command) => ControlPlaneCommandRuntimeContext;
  loadControlPlaneModel: (options: {
    repoRoot: string;
    baseSha: string | null;
    ref: string | null;
    shouldBuild: boolean;
  }) => Promise<{ model: ControlPlaneModel; baseSha: string } | null>;
  emitControlPlaneResult: <T>(result: T, output: ControlPlaneOutputOptions) => void;
  emitControlPlaneError: (error: ControlPlaneJsonError, output: ControlPlaneOutputOptions) => void;
  emitModelNotBuiltError: (
    message: string,
    output: ControlPlaneOutputOptions,
    details?: Record<string, unknown> | null,
  ) => void;
  resolveModelStoreError: (error: unknown) => ControlPlaneJsonError;
};

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerControlPlaneCommand(program: Command): void {
  const controlGraph = program
    .command("control-graph")
    .aliases(["cg", "control-plane", "cp"])
    .description("Control graph navigation surface for agents");

  registerControlPlaneFlags(controlGraph);
  registerControlPlaneDeprecationWarnings(program);

  const sharedContext: ControlPlaneCommandContext = {
    modelNotBuiltMessage: MODEL_NOT_BUILT_MESSAGE,
    resolveCommandContext,
    loadControlPlaneModel,
    emitControlPlaneResult,
    emitControlPlaneError,
    emitModelNotBuiltError,
    resolveModelStoreError,
  };

  controlGraph
    .command("build")
    .description("Build the repository navigation model")
    .option("--force", "Rebuild the navigation model even if cached", false)
    .action(async (opts, command) => {
      await handleControlPlaneBuild(opts, command);
    });

  controlGraph
    .command("info")
    .description("Show navigation model metadata")
    .action(async (_opts, command) => {
      await handleControlPlaneInfo(command);
    });

  registerComponentsCommands(controlGraph, sharedContext);
  registerDependencyCommands(controlGraph, sharedContext);
  registerBlastRadiusCommand(controlGraph, sharedContext);
  registerSearchCommand(controlGraph, sharedContext);
  registerPolicyCommands(controlGraph, sharedContext);
  registerSymbolCommands(controlGraph, sharedContext);
}

// =============================================================================
// COMMAND CONTEXT
// =============================================================================

function resolveCommandContext(command: Command): ControlPlaneCommandRuntimeContext {
  const flags = resolveControlPlaneFlags(command);
  return {
    flags,
    output: { useJson: flags.useJson, prettyJson: flags.prettyJson },
  };
}

// =============================================================================
// DEPRECATION WARNINGS
// =============================================================================

function registerControlPlaneDeprecationWarnings(program: Command): void {
  program.hook("preSubcommand", (root, subCommand) => {
    if (subCommand.name() !== "control-graph") {
      return;
    }

    if (!shouldWarnForDeprecatedControlPlaneAlias(resolveRawArgs(root))) {
      return;
    }

    emitControlPlaneDeprecationWarning();
  });
}

function emitControlPlaneDeprecationWarning(): void {
  process.stderr.write(`${CONTROL_PLANE_DEPRECATION_WARNING}\n`);
}

function shouldWarnForDeprecatedControlPlaneAlias(rawArgs: string[]): boolean {
  const topLevel = resolveTopLevelCommandName(rawArgs);
  return topLevel !== null && DEPRECATED_CONTROL_PLANE_ALIASES.has(topLevel);
}

function resolveTopLevelCommandName(rawArgs: string[]): string | null {
  const userArgs = rawArgs.length > 2 ? rawArgs.slice(2) : [];

  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];

    if (arg === "--") {
      return null;
    }

    if (arg.startsWith("-")) {
      if (arg === "--config") {
        index += 1;
        continue;
      }

      if (arg.startsWith("--config=")) {
        continue;
      }

      if (
        arg === "-v" ||
        arg === "--verbose" ||
        arg === "-V" ||
        arg === "--version" ||
        arg === "-h" ||
        arg === "--help"
      ) {
        continue;
      }

      continue;
    }

    return arg;
  }

  return null;
}

function resolveRawArgs(command: Command): string[] {
  const rawArgs = (command as Command & { rawArgs?: string[] }).rawArgs;
  return Array.isArray(rawArgs) ? rawArgs : [];
}

// =============================================================================
// BUILD + INFO ACTIONS
// =============================================================================

async function handleControlPlaneBuild(opts: { force?: boolean }, command: Command): Promise<void> {
  const { flags, output } = resolveCommandContext(command);

  try {
    const result = await buildControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      force: opts.force ?? false,
    });
    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

async function handleControlPlaneInfo(command: Command): Promise<void> {
  const { flags, output } = resolveCommandContext(command);

  try {
    const result = await getControlPlaneModelInfo({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
    });
    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

function resolveModelStoreError(error: unknown): ControlPlaneJsonError {
  if (error instanceof ControlPlaneBuildLockError) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.modelStoreError,
      message: error.message,
      details: { lock_path: error.lockPath },
    };
  }

  if (error instanceof Error) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.modelStoreError,
      message: error.message,
      details: { name: error.name },
    };
  }

  return {
    code: CONTROL_PLANE_ERROR_CODES.modelStoreError,
    message: "Control graph command failed.",
    details: null,
  };
}

// =============================================================================
// MODEL LOADING
// =============================================================================

async function loadControlPlaneModel(options: {
  repoRoot: string;
  baseSha: string | null;
  ref: string | null;
  shouldBuild: boolean;
}): Promise<{ model: ControlPlaneModel; baseSha: string } | null> {
  if (options.shouldBuild) {
    const buildResult = await buildControlPlaneModel({
      repoRoot: options.repoRoot,
      baseSha: options.baseSha,
      ref: options.ref,
    });
    const store = new ControlPlaneStore(options.repoRoot);
    const model = await store.readModel(buildResult.base_sha);
    return model ? { model, baseSha: buildResult.base_sha } : null;
  }

  const info = await getControlPlaneModelInfo({
    repoRoot: options.repoRoot,
    baseSha: options.baseSha,
    ref: options.ref,
  });

  if (!info.exists) {
    return null;
  }

  const store = new ControlPlaneStore(options.repoRoot);
  const model = await store.readModel(info.base_sha);
  return model ? { model, baseSha: info.base_sha } : null;
}
