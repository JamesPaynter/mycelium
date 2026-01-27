import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import { minimatch } from "minimatch";

import type { ControlPlaneJsonError } from "../../../control-plane/cli/output.js";
import { CONTROL_PLANE_ERROR_CODES } from "../../../control-plane/cli/output.js";
import { resolveTypeScriptSymbolReferences } from "../../../control-plane/extract/symbols-ts/refs.js";
import type {
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolReference,
} from "../../../control-plane/model/schema.js";

import type { ControlPlaneCommandContext } from "./index.js";

// =============================================================================
// SYMBOL COMMANDS
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

type SymbolRefsOptions = {
  limit?: number;
  includeDefinition?: boolean;
  groupBy?: string;
};

type SymbolReferenceGroupBy = "component" | "file";

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

type SymbolReferenceGroup = {
  key: string;
  references: ControlPlaneSymbolReference[];
};

type SymbolReferencesResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  total: number;
  limit: number;
  truncated: boolean;
  group_by: SymbolReferenceGroupBy | null;
  references: ControlPlaneSymbolReference[];
  groups: SymbolReferenceGroup[] | null;
};

type SymbolSnippet = {
  start_line: number;
  lines: string[];
};

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

function normalizeGroupBy(value?: string): SymbolReferenceGroupBy | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "component") {
    return "component";
  }

  if (normalized === "file") {
    return "file";
  }

  return null;
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
    matches = matches.filter((definition) => definition.name.toLowerCase().includes(query));
  }

  if (kindFilter) {
    matches = matches.filter((definition) => kindFilter.has(definition.kind));
  }

  if (options.component) {
    matches = matches.filter((definition) => definition.component_id === options.component);
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

function buildSymbolReferencesResult(options: {
  symbolId: string;
  definition: ControlPlaneSymbolDefinition | null;
  references: ControlPlaneSymbolReference[];
  limit: number;
  groupBy: SymbolReferenceGroupBy | null;
}): SymbolReferencesResult {
  const total = options.references.length;
  const limited = options.references.slice(0, options.limit);
  const truncated = total > options.limit;
  const groups = options.groupBy ? groupSymbolReferences(limited, options.groupBy) : null;

  return {
    symbol_id: options.symbolId,
    definition: options.definition,
    total,
    limit: options.limit,
    truncated,
    group_by: options.groupBy,
    references: limited,
    groups,
  };
}

function groupSymbolReferences(
  references: ControlPlaneSymbolReference[],
  groupBy: SymbolReferenceGroupBy,
): SymbolReferenceGroup[] {
  const groups = new Map<string, ControlPlaneSymbolReference[]>();

  for (const reference of references) {
    const key = groupBy === "component" ? reference.component_id : reference.file;
    const existing = groups.get(key);
    if (existing) {
      existing.push(reference);
    } else {
      groups.set(key, [reference]);
    }
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, groupReferences]) => ({ key, references: groupReferences }));
}

function buildSymbolRefsUnavailableError(options: {
  symbolId: string;
  symbolName: string;
  reason: string;
}): ControlPlaneJsonError {
  const hint = `Try: rg "${options.symbolName}"`;

  return {
    code: CONTROL_PLANE_ERROR_CODES.symbolRefsUnavailable,
    message: `Symbol references unavailable. ${hint}`,
    details: {
      symbol_id: options.symbolId,
      reason: options.reason,
      hint,
    },
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
