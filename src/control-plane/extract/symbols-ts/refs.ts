// Control plane TypeScript symbol references.
// Purpose: resolve reference sites for a symbol using the TypeScript language service.
// Assumes symbol definitions come from the same repo revision as the current sources.

import path from "node:path";

import ts from "typescript";

import { resolveOwnershipForPath } from "../ownership.js";
import type {
  ControlPlaneComponent,
  ControlPlaneOwnership,
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolRange,
  ControlPlaneSymbolReference,
} from "../../model/schema.js";
import type { TypeScriptProject } from "./tsconfig.js";
import { loadTypeScriptProject } from "./tsconfig.js";

export type TypeScriptSymbolReferenceResult =
  | {
      references: ControlPlaneSymbolReference[];
      warnings: string[];
    }
  | {
      references: null;
      warnings: string[];
      error: string;
    };

type TypeScriptReferenceProject = {
  project: TypeScriptProject;
  rootFileNames: string[];
  rootFileSet: Set<string>;
  fileNameIndex: Map<string, string>;
};

type SourceFileIndex = Map<string, ts.SourceFile>;

const UNKNOWN_COMPONENT_ID = "unknown";
const DOCUMENT_REGISTRY = ts.createDocumentRegistry();

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

export async function resolveTypeScriptSymbolReferences(options: {
  repoRoot: string;
  components: ControlPlaneComponent[];
  ownership: ControlPlaneOwnership;
  definition: ControlPlaneSymbolDefinition;
}): Promise<TypeScriptSymbolReferenceResult> {
  try {
    const projectResult = await loadTypeScriptProject(options.repoRoot);
    if (!projectResult.project) {
      return {
        references: null,
        warnings: projectResult.warnings,
        error: "TypeScript project unavailable for references.",
      };
    }

    const project = prepareProject(projectResult.project);
    const definitionFileName = resolveDefinitionFileName(
      options.repoRoot,
      options.definition,
      project.fileNameIndex,
    );

    if (!definitionFileName) {
      return {
        references: null,
        warnings: projectResult.warnings,
        error: "Symbol definition file is not part of the TypeScript project.",
      };
    }

    const languageService = createLanguageService({
      repoRoot: options.repoRoot,
      project: project.project,
      rootFileNames: project.rootFileNames,
    });
    const referencedSymbols = languageService.findReferences(
      definitionFileName,
      options.definition.range.start_offset,
    );

    if (!referencedSymbols) {
      return {
        references: null,
        warnings: projectResult.warnings,
        error: "TypeScript language service returned no references.",
      };
    }

    const program = languageService.getProgram();
    if (!program) {
      return {
        references: null,
        warnings: projectResult.warnings,
        error: "TypeScript program unavailable for references.",
      };
    }

    const sourceFileIndex = indexSourceFiles(program);
    const componentCache = new Map<string, string>();
    const references: ControlPlaneSymbolReference[] = [];

    const definitionPath = normalizeFilePath(definitionFileName);
    const definitionOffset = options.definition.range.start_offset;
    const entries = collectReferenceEntries(referencedSymbols);

    for (const entry of entries) {
      const normalizedFileName = normalizeFilePath(entry.fileName);
      if (!project.rootFileSet.has(normalizedFileName)) {
        continue;
      }

      const sourceFile =
        program.getSourceFile(entry.fileName) ??
        sourceFileIndex.get(normalizedFileName);
      if (!sourceFile || sourceFile.isDeclarationFile) {
        continue;
      }

      const repoPath = toRepoRelativePath(options.repoRoot, entry.fileName);
      if (!repoPath || shouldIgnoreRepoPath(repoPath)) {
        continue;
      }

      const isDefinition =
        entry.isDefinition ??
        (normalizedFileName === definitionPath &&
          entry.textSpan.start === definitionOffset);

      references.push({
        file: repoPath,
        range: createSymbolRange(sourceFile, entry.textSpan),
        is_definition: isDefinition,
        component_id: resolveComponentId(
          options.ownership,
          options.components,
          repoPath,
          componentCache,
        ),
      });
    }

    return {
      references: sortSymbolReferences(references),
      warnings: projectResult.warnings,
    };
  } catch (error) {
    return {
      references: null,
      warnings: [],
      error: formatReferenceError(error),
    };
  }
}



// =============================================================================
// PROJECT PREP
// =============================================================================

function prepareProject(project: TypeScriptProject): TypeScriptReferenceProject {
  const rootFileNames = sortFileNames(project.rootFileNames);
  const rootFileSet = new Set(rootFileNames.map((fileName) => normalizeFilePath(fileName)));
  const fileNameIndex = buildFileNameIndex(rootFileNames);

  return {
    project,
    rootFileNames,
    rootFileSet,
    fileNameIndex,
  };
}

function sortFileNames(fileNames: string[]): string[] {
  return [...fileNames].sort((left, right) => left.localeCompare(right));
}

function buildFileNameIndex(fileNames: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const fileName of fileNames) {
    index.set(normalizeFilePath(fileName), fileName);
  }
  return index;
}

function resolveDefinitionFileName(
  repoRoot: string,
  definition: ControlPlaneSymbolDefinition,
  fileNameIndex: Map<string, string>,
): string | null {
  const absolutePath = path.resolve(repoRoot, definition.file);
  const normalized = normalizeFilePath(absolutePath);
  return fileNameIndex.get(normalized) ?? null;
}

function collectReferenceEntries(
  referencedSymbols: ts.ReferencedSymbol[],
): ts.ReferencedSymbolEntry[] {
  const entries: ts.ReferencedSymbolEntry[] = [];
  const seen = new Set<string>();

  for (const symbol of referencedSymbols) {
    for (const entry of symbol.references) {
      const key = buildReferenceKey(entry);
      if (seen.has(key)) {
        continue;
      }

      entries.push(entry);
      seen.add(key);
    }
  }

  return entries;
}

function buildReferenceKey(entry: ts.ReferencedSymbolEntry): string {
  const normalizedFileName = normalizeFilePath(entry.fileName);
  return `${normalizedFileName}:${entry.textSpan.start}:${entry.textSpan.length}`;
}



// =============================================================================
// LANGUAGE SERVICE
// =============================================================================

function createLanguageService(options: {
  repoRoot: string;
  project: TypeScriptProject;
  rootFileNames: string[];
}): ts.LanguageService {
  const compilerOptions = options.project.program.getCompilerOptions();
  const sourceFileIndex = indexSourceFiles(options.project.program);
  const snapshotCache = new Map<string, ts.IScriptSnapshot>();
  const scriptVersions = new Map(
    options.rootFileNames.map((fileName) => [normalizeFilePath(fileName), "1"]),
  );

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => options.rootFileNames,
    getScriptVersion: (fileName) =>
      scriptVersions.get(normalizeFilePath(fileName)) ?? "0",
    getScriptSnapshot: (fileName) =>
      getScriptSnapshot(fileName, sourceFileIndex, snapshotCache),
    getCurrentDirectory: () => options.repoRoot,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return ts.createLanguageService(host, DOCUMENT_REGISTRY);
}

function indexSourceFiles(program: ts.Program): SourceFileIndex {
  const index = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    index.set(normalizeFilePath(sourceFile.fileName), sourceFile);
  }

  return index;
}

function getScriptSnapshot(
  fileName: string,
  sourceFileIndex: SourceFileIndex,
  snapshotCache: Map<string, ts.IScriptSnapshot>,
): ts.IScriptSnapshot | undefined {
  const normalized = normalizeFilePath(fileName);
  const cached = snapshotCache.get(normalized);
  if (cached) {
    return cached;
  }

  const sourceFile = sourceFileIndex.get(normalized);
  if (sourceFile) {
    const snapshot = ts.ScriptSnapshot.fromString(sourceFile.text);
    snapshotCache.set(normalized, snapshot);
    return snapshot;
  }

  if (!ts.sys.fileExists(fileName)) {
    return undefined;
  }

  const sourceText = ts.sys.readFile(fileName);
  if (sourceText === undefined) {
    return undefined;
  }

  const snapshot = ts.ScriptSnapshot.fromString(sourceText);
  snapshotCache.set(normalized, snapshot);
  return snapshot;
}



// =============================================================================
// REFERENCE NORMALIZATION
// =============================================================================

function createSymbolRange(
  sourceFile: ts.SourceFile,
  textSpan: ts.TextSpan,
): ControlPlaneSymbolRange {
  const startOffset = textSpan.start;
  const endOffset = textSpan.start + textSpan.length;
  const startLocation = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const endLocation = sourceFile.getLineAndCharacterOfPosition(endOffset);

  return {
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

function sortSymbolReferences(
  references: ControlPlaneSymbolReference[],
): ControlPlaneSymbolReference[] {
  return [...references].sort(compareSymbolReferences);
}

function compareSymbolReferences(
  left: ControlPlaneSymbolReference,
  right: ControlPlaneSymbolReference,
): number {
  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }

  if (left.range.start_offset !== right.range.start_offset) {
    return left.range.start_offset - right.range.start_offset;
  }

  if (left.range.end_offset !== right.range.end_offset) {
    return left.range.end_offset - right.range.end_offset;
  }

  if (left.is_definition !== right.is_definition) {
    return left.is_definition ? -1 : 1;
  }

  if (left.component_id !== right.component_id) {
    return left.component_id.localeCompare(right.component_id);
  }

  return 0;
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

function formatReferenceError(error: unknown): string {
  if (error instanceof Error) {
    return `TypeScript symbol references failed: ${error.message}`;
  }

  return "TypeScript symbol references failed with an unknown error.";
}
