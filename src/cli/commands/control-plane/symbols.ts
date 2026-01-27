import { Command } from "commander";

import { resolveTypeScriptSymbolReferences } from "../../../control-plane/extract/symbols-ts/refs.js";

import {
  buildSymbolReferencesResult,
  buildSymbolRefsUnavailableError,
  findSymbols,
  loadSymbolSnippet,
  normalizeContextLines,
  normalizeGroupBy,
  normalizeLimit,
  normalizeSymbolQuery,
  type SymbolDefOptions,
  type SymbolDefinitionResult,
  type SymbolFindOptions,
  type SymbolRefsOptions,
} from "./symbols-helpers.js";

import type { ControlPlaneCommandContext } from "./index.js";

// =============================================================================
// SYMBOL COMMANDS
// =============================================================================

export function registerSymbolCommands(
  controlGraph: Command,
  sharedContext: ControlPlaneCommandContext,
): void {
  const symbols = controlGraph.command("symbols").description("Symbol navigation queries");

  symbols
    .command("find")
    .description("Search for symbols")
    .argument("[query...]", "Search terms")
    .option("--kind <kind...>", "Filter by symbol kind")
    .option("--component <id>", "Filter by component id")
    .option("--path <glob>", "Filter by file path glob")
    .option("--limit <n>", "Limit number of matches (default: 50)", (value) => parseInt(value, 10))
    .action(async (query, opts, command) => {
      await handleSymbolsFind(query as string[] | string, opts as SymbolFindOptions, command, sharedContext);
    });

  symbols
    .command("def")
    .description("Show symbol definitions")
    .argument("<symbol_id>", "Symbol id")
    .option("--context <n>", "Include snippet context lines", (value) => parseInt(value, 10))
    .action(async (symbolId, opts, command) => {
      await handleSymbolsDef(String(symbolId), opts as SymbolDefOptions, command, sharedContext);
    });

  symbols
    .command("refs")
    .description("Show symbol references")
    .argument("<symbol_id>", "Symbol id")
    .option("--limit <n>", "Limit number of references (default: 50)", (value) =>
      parseInt(value, 10),
    )
    .option("--include-definition", "Include definition references", false)
    .option("--group-by <mode>", "Group references by component or file")
    .action(async (symbolId, opts, command) => {
      await handleSymbolsRefs(String(symbolId), opts as SymbolRefsOptions, command, sharedContext);
    });
}

async function handleSymbolsFind(
  queryParts: string[] | string,
  options: SymbolFindOptions,
  command: Command,
  sharedContext: ControlPlaneCommandContext,
): Promise<void> {
  const { flags, output } = sharedContext.resolveCommandContext(command);

  try {
    const modelResult = await sharedContext.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      sharedContext.emitModelNotBuiltError(sharedContext.modelNotBuiltMessage, output);
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

    sharedContext.emitControlPlaneResult(result, output);
  } catch (error) {
    sharedContext.emitControlPlaneError(sharedContext.resolveModelStoreError(error), output);
  }
}

async function handleSymbolsDef(
  symbolId: string,
  options: SymbolDefOptions,
  command: Command,
  sharedContext: ControlPlaneCommandContext,
): Promise<void> {
  const { flags, output } = sharedContext.resolveCommandContext(command);

  try {
    const modelResult = await sharedContext.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      sharedContext.emitModelNotBuiltError(sharedContext.modelNotBuiltMessage, output);
      return;
    }

    const normalizedId = symbolId.trim();
    const definitions = modelResult.model.symbols_ts?.definitions ?? [];
    const definition = definitions.find((entry) => entry.symbol_id === normalizedId) ?? null;

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

    sharedContext.emitControlPlaneResult(result, output);
  } catch (error) {
    sharedContext.emitControlPlaneError(sharedContext.resolveModelStoreError(error), output);
  }
}

async function handleSymbolsRefs(
  symbolId: string,
  options: SymbolRefsOptions,
  command: Command,
  sharedContext: ControlPlaneCommandContext,
): Promise<void> {
  const { flags, output } = sharedContext.resolveCommandContext(command);

  try {
    const modelResult = await sharedContext.loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });

    if (!modelResult) {
      sharedContext.emitModelNotBuiltError(sharedContext.modelNotBuiltMessage, output);
      return;
    }

    const normalizedId = symbolId.trim();
    const definitions = modelResult.model.symbols_ts?.definitions ?? [];
    const definition = definitions.find((entry) => entry.symbol_id === normalizedId) ?? null;

    const limit = normalizeLimit(options.limit, 50);
    const groupBy = normalizeGroupBy(options.groupBy);
    const includeDefinition = options.includeDefinition ?? false;

    if (!definition) {
      sharedContext.emitControlPlaneResult(
        buildSymbolReferencesResult({
          symbolId: normalizedId,
          definition: null,
          references: [],
          limit,
          groupBy,
        }),
        output,
      );
      return;
    }

    const referenceResult = await resolveTypeScriptSymbolReferences({
      repoRoot: flags.repoPath,
      components: modelResult.model.components,
      ownership: modelResult.model.ownership,
      definition,
    });

    if (referenceResult.references === null) {
      sharedContext.emitControlPlaneError(
        buildSymbolRefsUnavailableError({
          symbolId: normalizedId,
          symbolName: definition.name,
          reason: referenceResult.error,
        }),
        output,
      );
      return;
    }

    const filtered = includeDefinition
      ? referenceResult.references
      : referenceResult.references.filter((ref) => !ref.is_definition);

    sharedContext.emitControlPlaneResult(
      buildSymbolReferencesResult({
        symbolId: normalizedId,
        definition,
        references: filtered,
        limit,
        groupBy,
      }),
      output,
    );
  } catch (error) {
    sharedContext.emitControlPlaneError(sharedContext.resolveModelStoreError(error), output);
  }
}
