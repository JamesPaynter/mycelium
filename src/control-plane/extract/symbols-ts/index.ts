// Control plane TypeScript symbol extraction.
// Purpose: collect definition sites for common TypeScript declarations.
// Assumes ownership roots are repo-relative paths using forward slashes.

import path from "node:path";

import ts from "typescript";

import { resolveOwnershipForPath } from "../ownership.js";
import type {
  ControlPlaneComponent,
  ControlPlaneOwnership,
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolDefinitionKind,
} from "../../model/schema.js";
import { loadTypeScriptProject } from "./tsconfig.js";

export type TypeScriptSymbolExtractionResult = {
  definitions: ControlPlaneSymbolDefinition[];
  warnings: string[];
};

type SourceFileContext = {
  sourceFile: ts.SourceFile;
  filePath: string;
  componentId: string;
};

const UNKNOWN_COMPONENT_ID = "unknown";

const IGNORED_ROOTS = new Set([
  "node_modules",
  ".git",
  ".mycelium",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "vendor",
]);



// =============================================================================
// PUBLIC API
// =============================================================================

export async function extractTypeScriptSymbolDefinitions(options: {
  repoRoot: string;
  components: ControlPlaneComponent[];
  ownership: ControlPlaneOwnership;
}): Promise<TypeScriptSymbolExtractionResult> {
  try {
    const projectResult = await loadTypeScriptProject(options.repoRoot);
    if (!projectResult.project) {
      return { definitions: [], warnings: projectResult.warnings };
    }

    const rootFileSet = new Set(
      projectResult.project.rootFileNames.map((fileName) => normalizeFilePath(fileName)),
    );
    const componentCache = new Map<string, string>();
    const definitions: ControlPlaneSymbolDefinition[] = [];

    for (const sourceFile of projectResult.project.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) {
        continue;
      }

      const normalizedFileName = normalizeFilePath(sourceFile.fileName);
      if (!rootFileSet.has(normalizedFileName)) {
        continue;
      }

      const repoPath = toRepoRelativePath(options.repoRoot, sourceFile.fileName);
      if (!repoPath || shouldIgnoreRepoPath(repoPath)) {
        continue;
      }

      const componentId = resolveComponentId(
        options.ownership,
        options.components,
        repoPath,
        componentCache,
      );

      const fileDefinitions = extractDefinitionsFromSourceFile({
        sourceFile,
        filePath: repoPath,
        componentId,
      });
      definitions.push(...fileDefinitions);
    }

    return {
      definitions: sortSymbolDefinitions(definitions),
      warnings: projectResult.warnings,
    };
  } catch (error) {
    return { definitions: [], warnings: [formatExtractionError(error)] };
  }
}



// =============================================================================
// DEFINITION EXTRACTION
// =============================================================================

function extractDefinitionsFromSourceFile(context: SourceFileContext): ControlPlaneSymbolDefinition[] {
  const definitions: ControlPlaneSymbolDefinition[] = [];

  for (const statement of context.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      addNamedDefinition(definitions, context, statement.name, "function");
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      addNamedDefinition(definitions, context, statement.name, "class");
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      addNamedDefinition(definitions, context, statement.name, "interface");
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      addNamedDefinition(definitions, context, statement.name, "type");
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      addNamedDefinition(definitions, context, statement.name, "enum");
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      if (!isExportedStatement(statement)) {
        continue;
      }

      const kind = resolveVariableKind(statement.declarationList);
      if (!kind) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }

        definitions.push(
          createSymbolDefinition({
            nameNode: declaration.name,
            kind,
            filePath: context.filePath,
            componentId: context.componentId,
            sourceFile: context.sourceFile,
          }),
        );
      }
    }
  }

  return definitions;
}

function addNamedDefinition(
  definitions: ControlPlaneSymbolDefinition[],
  context: SourceFileContext,
  nameNode: ts.Identifier | undefined,
  kind: ControlPlaneSymbolDefinitionKind,
): void {
  if (!nameNode) {
    return;
  }

  definitions.push(
    createSymbolDefinition({
      nameNode,
      kind,
      filePath: context.filePath,
      componentId: context.componentId,
      sourceFile: context.sourceFile,
    }),
  );
}

function resolveVariableKind(
  declarationList: ts.VariableDeclarationList,
): ControlPlaneSymbolDefinitionKind | null {
  if (declarationList.flags & ts.NodeFlags.Const) {
    return "const";
  }

  if (declarationList.flags & ts.NodeFlags.Let) {
    return "let";
  }

  return null;
}

function isExportedStatement(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) {
    return false;
  }

  const modifiers = ts.getModifiers(statement);
  if (!modifiers) {
    return false;
  }

  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function createSymbolDefinition(options: {
  nameNode: ts.Identifier;
  kind: ControlPlaneSymbolDefinitionKind;
  filePath: string;
  componentId: string;
  sourceFile: ts.SourceFile;
}): ControlPlaneSymbolDefinition {
  const name = options.nameNode.text;
  const startOffset = options.nameNode.getStart(options.sourceFile);
  const endOffset = options.nameNode.getEnd();
  const startLocation =
    options.sourceFile.getLineAndCharacterOfPosition(startOffset);
  const endLocation =
    options.sourceFile.getLineAndCharacterOfPosition(endOffset);

  return {
    symbol_id: buildSymbolId({
      componentId: options.componentId,
      name,
      filePath: options.filePath,
      startOffset,
    }),
    name,
    kind: options.kind,
    file: options.filePath,
    range: {
      start: {
        line: startLocation.line + 1,
        column: startLocation.character + 1,
      },
      end: {
        line: endLocation.line + 1,
        column: endLocation.character + 1,
      },
      start_offset: startOffset,
      end_offset: endOffset,
    },
    component_id: options.componentId,
  };
}



// =============================================================================
// COMPONENT RESOLUTION
// =============================================================================

function resolveComponentId(
  ownership: ControlPlaneOwnership,
  components: ControlPlaneComponent[],
  repoPath: string,
  cache: Map<string, string>,
): string {
  const cached = cache.get(repoPath);
  if (cached) {
    return cached;
  }

  const match = resolveOwnershipForPath(ownership, components, repoPath);
  const componentId = match.owner?.component.id ?? UNKNOWN_COMPONENT_ID;
  cache.set(repoPath, componentId);
  return componentId;
}



// =============================================================================
// SORTING
// =============================================================================

function sortSymbolDefinitions(
  definitions: ControlPlaneSymbolDefinition[],
): ControlPlaneSymbolDefinition[] {
  return [...definitions].sort(compareSymbolDefinitions);
}

function compareSymbolDefinitions(
  left: ControlPlaneSymbolDefinition,
  right: ControlPlaneSymbolDefinition,
): number {
  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }

  if (left.range.start_offset !== right.range.start_offset) {
    return left.range.start_offset - right.range.start_offset;
  }

  if (left.name !== right.name) {
    return left.name.localeCompare(right.name);
  }

  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }

  return left.symbol_id.localeCompare(right.symbol_id);
}



// =============================================================================
// IDENTIFIERS
// =============================================================================

function buildSymbolId(options: {
  componentId: string;
  name: string;
  filePath: string;
  startOffset: number;
}): string {
  return `ts:${options.componentId}/${options.name}@${options.filePath}:${options.startOffset}`;
}



// =============================================================================
// PATH HELPERS
// =============================================================================

function toRepoRelativePath(repoRoot: string, filePath: string): string | null {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return normalizeRepoPath(relativePath);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}

function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function shouldIgnoreRepoPath(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  const root = normalized.split("/")[0] ?? "";
  return IGNORED_ROOTS.has(root);
}



// =============================================================================
// ERROR HANDLING
// =============================================================================

function formatExtractionError(error: unknown): string {
  if (error instanceof Error) {
    return `TypeScript symbol extraction failed: ${error.message}`;
  }

  return "TypeScript symbol extraction failed with an unknown error.";
}
