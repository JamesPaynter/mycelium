import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import { minimatch } from "minimatch";

import { registerControlPlaneFlags, resolveControlPlaneFlags } from "../control-plane/cli/flags.js";
import type {
  ControlPlaneJsonError,
  ControlPlaneOutputOptions,
} from "../control-plane/cli/output.js";
import {
  CONTROL_PLANE_ERROR_CODES,
  emitControlPlaneError,
  emitControlPlaneResult,
  emitModelNotBuiltError,
  emitNotImplementedError,
} from "../control-plane/cli/output.js";
import { computeBlastRadius } from "../control-plane/blast.js";
import { resolveOwnershipForPath } from "../control-plane/extract/ownership.js";
import { listChangedPaths } from "../control-plane/git.js";
import { buildControlPlaneModel, getControlPlaneModelInfo } from "../control-plane/model/build.js";
import {
  resolveComponentDependencies,
  resolveComponentReverseDependencies,
} from "../control-plane/model/deps.js";
import type {
  ControlPlaneModel,
  ControlPlaneSymbolDefinition,
} from "../control-plane/model/schema.js";
import { ControlPlaneBuildLockError, ControlPlaneStore } from "../control-plane/storage.js";

const MODEL_NOT_BUILT_MESSAGE =
  "Control plane model not built. Run `mycelium cp build` to generate it.";
const NOT_IMPLEMENTED_MESSAGE = "Control plane command not implemented yet.";



// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerControlPlaneCommand(program: Command): void {
  const controlPlane = program
    .command("control-plane")
    .alias("cp")
    .description("Repository navigation surface for agents");

  registerControlPlaneFlags(controlPlane);

  controlPlane
    .command("build")
    .description("Build the repository navigation model")
    .option("--force", "Rebuild the navigation model even if cached", false)
    .action(async (opts, command) => {
      await handleControlPlaneBuild(opts, command);
    });

  controlPlane
    .command("info")
    .description("Show navigation model metadata")
    .action(async (_opts, command) => {
      await handleControlPlaneInfo(command);
    });

  const components = controlPlane
    .command("components")
    .description("Component catalog queries");

  components
    .command("list")
    .description("List known components")
    .action(async (...args) => {
      await handleComponentsList(resolveCommandFromArgs(args));
    });

  components
    .command("show")
    .description("Show component details")
    .argument("<id>", "Component id")
    .action(async (id, ...rest) => {
      await handleComponentsShow(String(id), resolveCommandFromArgs(rest));
    });

  controlPlane
    .command("owner")
    .description("Show owning component for a path")
    .argument("<path>", "Path to inspect")
    .action(async (targetPath, ...rest) => {
      await handleOwnerLookup(String(targetPath), resolveCommandFromArgs(rest));
    });

  controlPlane
    .command("deps")
    .description("Show dependencies for a component")
    .argument("<component>", "Component id")
    .option("--transitive", "Include transitive dependencies", false)
    .option("--limit <n>", "Limit number of edges", (value) => parseInt(value, 10))
    .action(async (componentId, opts, command) => {
      await handleDependencyQuery(
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
        String(componentId),
        "rdeps",
        opts as DependencyQueryOptions,
        command,
      );
    });

  controlPlane
    .command("blast")
    .description("Estimate blast radius for a change")
    .argument("[targets...]", "Paths to treat as changed")
    .option("--changed <paths...>", "Paths to treat as changed")
    .option("--diff <range>", "Git diff rev range (e.g., HEAD~1..HEAD)")
    .option("--against <ref>", "Git ref to diff against HEAD")
    .action(async (targets, opts, command) => {
      await handleBlastQuery(targets as string[], opts as BlastQueryOptions, command);
    });

  const symbols = controlPlane
    .command("symbols")
    .description("Symbol navigation queries");

  symbols
    .command("find")
    .description("Search for symbols")
    .argument("[query...]", "Search terms")
    .option("--kind <kind...>", "Filter by symbol kind")
    .option("--component <id>", "Filter by component id")
    .option("--path <glob>", "Filter by file path glob")
    .option(
      "--limit <n>",
      "Limit number of matches (default: 50)",
      (value) => parseInt(value, 10),
    )
    .action(async (query, opts, command) => {
      await handleSymbolsFind(query as string[] | string, opts as SymbolFindOptions, command);
    });

  symbols
    .command("def")
    .description("Show symbol definitions")
    .argument("<symbol_id>", "Symbol id")
    .option("--context <n>", "Include snippet context lines", (value) => parseInt(value, 10))
    .action(async (symbolId, opts, command) => {
      await handleSymbolsDef(String(symbolId), opts as SymbolDefOptions, command);
    });

  symbols
    .command("refs")
    .description("Show symbol references")
    .argument("[query...]", "Search terms")
    .action(createNotImplementedAction());
}



// =============================================================================
// STUB HELPERS
// =============================================================================

function createModelNotBuiltAction(
  message: string = MODEL_NOT_BUILT_MESSAGE,
): (...args: unknown[]) => void {
  return createErrorAction((output) => emitModelNotBuiltError(message, output));
}

function createNotImplementedAction(
  message: string = NOT_IMPLEMENTED_MESSAGE,
): (...args: unknown[]) => void {
  return createErrorAction((output) => emitNotImplementedError(message, output));
}

function createErrorAction(
  emit: (output: ControlPlaneOutputOptions) => void,
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const output = resolveOutputOptions(command);
    emit(output);
  };
}

function resolveOutputOptions(command: Command): ControlPlaneOutputOptions {
  const flags = resolveControlPlaneFlags(command);
  return { useJson: flags.useJson, prettyJson: flags.prettyJson };
}

function resolveCommandFromArgs(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}



// =============================================================================
// BUILD + INFO ACTIONS
// =============================================================================

async function handleControlPlaneBuild(
  opts: { force?: boolean },
  command: Command,
): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

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
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

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
    message: "Control plane command failed.",
    details: null,
  };
}



// =============================================================================
// COMPONENT + OWNER QUERIES
// =============================================================================

async function handleComponentsList(command: Command): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    emitControlPlaneResult(modelResult.model.components, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

async function handleComponentsShow(componentId: string, command: Command): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    const component =
      modelResult.model.components.find((entry) => entry.id === componentId) ?? null;

    emitControlPlaneResult(component, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

async function handleOwnerLookup(targetPath: string, command: Command): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    const repoRelativePath = resolveRepoRelativePath(flags.repoPath, targetPath);
    const result = resolveOwnershipForPath(
      modelResult.model.ownership,
      modelResult.model.components,
      repoRelativePath,
    );

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}



// =============================================================================
// DEPENDENCY QUERIES
// =============================================================================

type DependencyQueryOptions = {
  transitive?: boolean;
  limit?: number;
};

async function handleDependencyQuery(
  componentId: string,
  direction: "deps" | "rdeps",
  options: DependencyQueryOptions,
  command: Command,
): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
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

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}



// =============================================================================
// BLAST QUERY
// =============================================================================

type BlastQueryOptions = {
  changed?: string[];
  diff?: string;
  against?: string;
};

async function handleBlastQuery(
  targets: string[],
  options: BlastQueryOptions,
  command: Command,
): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    const changedInput =
      options.changed && options.changed.length > 0 ? options.changed : targets;
    const changedPaths = await listChangedPaths({
      repoRoot: flags.repoPath,
      changed: changedInput,
      diff: options.diff ?? null,
      against: options.against ?? null,
    });

    const result = computeBlastRadius({
      changedPaths,
      model: modelResult.model,
    });

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}



// =============================================================================
// SYMBOL QUERIES
// =============================================================================

type SymbolFindOptions = {
  kind?: string[];
  component?: string;
  path?: string;
  limit?: number;
};

type SymbolDefOptions = {
  context?: number;
};

type SymbolFindResult = {
  query: string;
  total: number;
  limit: number;
  truncated: boolean;
  matches: ControlPlaneSymbolDefinition[];
};

type SymbolDefinitionResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  snippet: SymbolSnippet | null;
};

type SymbolSnippet = {
  start_line: number;
  lines: string[];
};

async function handleSymbolsFind(
  queryParts: string[] | string,
  options: SymbolFindOptions,
  command: Command,
): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    const definitions = modelResult.model.symbols_ts?.definitions ?? [];
    const query = normalizeSymbolQuery(queryParts);
    const result = findSymbols({
      definitions,
      query,
      kind: options.kind ?? null,
      component: options.component ?? null,
      path: options.path ?? null,
      limit: normalizeLimit(options.limit, 50),
    });

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

async function handleSymbolsDef(
  symbolId: string,
  options: SymbolDefOptions,
  command: Command,
): Promise<void> {
  const output = resolveOutputOptions(command);
  const flags = resolveControlPlaneFlags(command);

  try {
    const modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
      return;
    }

    const normalizedId = symbolId.trim();
    const definitions = modelResult.model.symbols_ts?.definitions ?? [];
    const definition =
      definitions.find((entry) => entry.symbol_id === normalizedId) ?? null;

    const context = normalizeContextLines(options.context);
    const snippet =
      definition && context
        ? await loadSymbolSnippet({
            repoRoot: flags.repoPath,
            filePath: definition.file,
            line: definition.range.start.line,
            context,
          })
        : null;

    const result: SymbolDefinitionResult = {
      symbol_id: normalizedId,
      definition,
      snippet,
    };

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

function normalizeSymbolQuery(queryParts: string[] | string | undefined): string {
  if (!queryParts || queryParts.length === 0) {
    return "";
  }

  if (Array.isArray(queryParts)) {
    return queryParts.join(" ").trim();
  }

  return String(queryParts).trim();
}

function normalizeSymbolKinds(kinds: string[] | null): Set<string> | null {
  if (!kinds || kinds.length === 0) {
    return null;
  }

  const normalized = kinds
    .map((kind) => kind.trim().toLowerCase())
    .filter((kind) => kind.length > 0);

  return normalized.length > 0 ? new Set(normalized) : null;
}

function normalizeContextLines(value?: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : null;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : fallback;
}

function findSymbols(options: {
  definitions: ControlPlaneSymbolDefinition[];
  query: string;
  kind: string[] | null;
  component: string | null;
  path: string | null;
  limit: number;
}): SymbolFindResult {
  const query = options.query.toLowerCase();
  const kindFilter = normalizeSymbolKinds(options.kind);

  let matches = options.definitions;

  if (query.length > 0) {
    matches = matches.filter((definition) =>
      definition.name.toLowerCase().includes(query),
    );
  }

  if (kindFilter) {
    matches = matches.filter((definition) => kindFilter.has(definition.kind));
  }

  if (options.component) {
    matches = matches.filter(
      (definition) => definition.component_id === options.component,
    );
  }

  if (options.path) {
    matches = matches.filter((definition) =>
      minimatch(definition.file, options.path ?? "", { dot: true }),
    );
  }

  const total = matches.length;
  const limited = matches.slice(0, options.limit);

  return {
    query: options.query,
    total,
    limit: options.limit,
    truncated: total > options.limit,
    matches: limited,
  };
}

async function loadSymbolSnippet(options: {
  repoRoot: string;
  filePath: string;
  line: number;
  context: number;
}): Promise<SymbolSnippet | null> {
  try {
    const absolutePath = path.resolve(options.repoRoot, options.filePath);
    const source = await fs.readFile(absolutePath, "utf8");
    const lines = source.split(/\r?\n/);
    const startLine = Math.max(1, options.line - options.context);
    const endLine = Math.min(lines.length, options.line + options.context);
    const snippetLines = lines.slice(startLine - 1, endLine);

    return {
      start_line: startLine,
      lines: snippetLines,
    };
  } catch {
    return null;
  }
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

function resolveRepoRelativePath(repoRoot: string, targetPath: string): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(resolvedRepoRoot, targetPath);
  return path.relative(resolvedRepoRoot, resolvedTarget);
}
