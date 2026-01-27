// Control plane TypeScript symbol references.
// Purpose: resolve reference sites for a symbol using the TypeScript language service.
// Assumes symbol definitions come from the same repo revision as the current sources.

import type {
  ControlPlaneComponent,
  ControlPlaneOwnership,
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolReference,
} from "../../model/schema.js";

import {
  collectReferenceEntries,
  createLanguageService,
  createSymbolRange,
  formatReferenceError,
  indexSourceFiles,
  normalizeFilePath,
  prepareProject,
  resolveComponentId,
  resolveDefinitionFileName,
  shouldIgnoreRepoPath,
  sortSymbolReferences,
  toRepoRelativePath,
} from "./refs-helpers.js";
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
        program.getSourceFile(entry.fileName) ?? sourceFileIndex.get(normalizedFileName);
      if (!sourceFile || sourceFile.isDeclarationFile) {
        continue;
      }

      const repoPath = toRepoRelativePath(options.repoRoot, entry.fileName);
      if (!repoPath || shouldIgnoreRepoPath(repoPath)) {
        continue;
      }

      const isDefinition =
        entry.isDefinition ??
        (normalizedFileName === definitionPath && entry.textSpan.start === definitionOffset);

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
