import fs from "node:fs/promises";
import path from "node:path";

import { minimatch } from "minimatch";

import type { ControlPlaneJsonError } from "../../../control-plane/cli/output.js";
import { CONTROL_PLANE_ERROR_CODES } from "../../../control-plane/cli/output.js";
import type {
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolReference,
} from "../../../control-plane/model/schema.js";

// =============================================================================
// TYPES
// =============================================================================

export type SymbolFindOptions = {
  kind?: string[];
  component?: string;
  path?: string;
  limit?: number;
};

export type SymbolDefOptions = {
  context?: number;
};

export type SymbolRefsOptions = {
  limit?: number;
  includeDefinition?: boolean;
  groupBy?: string;
};

export type SymbolReferenceGroupBy = "component" | "file";

export type SymbolFindResult = {
  query: string;
  total: number;
  limit: number;
  truncated: boolean;
  matches: ControlPlaneSymbolDefinition[];
};

export type SymbolDefinitionResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  snippet: SymbolSnippet | null;
};

export type SymbolReferenceGroup = {
  key: string;
  references: ControlPlaneSymbolReference[];
};

export type SymbolReferencesResult = {
  symbol_id: string;
  definition: ControlPlaneSymbolDefinition | null;
  total: number;
  limit: number;
  truncated: boolean;
  group_by: SymbolReferenceGroupBy | null;
  references: ControlPlaneSymbolReference[];
  groups: SymbolReferenceGroup[] | null;
};

export type SymbolSnippet = {
  start_line: number;
  lines: string[];
};

// =============================================================================
// NORMALIZATION
// =============================================================================

export function normalizeSymbolQuery(queryParts: string[] | string | undefined): string {
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

export function normalizeContextLines(value?: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : null;
}

export function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : fallback;
}

export function normalizeGroupBy(value?: string): SymbolReferenceGroupBy | null {
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

// =============================================================================
// SYMBOL FINDING
// =============================================================================

export function findSymbols(options: {
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

// =============================================================================
// REFERENCES
// =============================================================================

export function buildSymbolReferencesResult(options: {
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

export function buildSymbolRefsUnavailableError(options: {
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

// =============================================================================
// SNIPPETS
// =============================================================================

export async function loadSymbolSnippet(options: {
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
