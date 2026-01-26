// Control plane TypeScript program resolver.
// Purpose: resolve a root tsconfig or fall back to ad-hoc source discovery.
// Assumes repoRoot is an absolute path and repo-relative paths use forward slashes.

import path from "node:path";

import fg from "fast-glob";
import fse from "fs-extra";
import ts from "typescript";

export type TypeScriptProjectKind = "tsconfig" | "ad-hoc";

export type TypeScriptProject = {
  kind: TypeScriptProjectKind;
  program: ts.Program;
  rootFileNames: string[];
};

export type TypeScriptProjectLoadResult = {
  project: TypeScriptProject | null;
  warnings: string[];
};

const AD_HOC_FILE_GLOBS = ["src/**/*.ts"];
const AD_HOC_FILE_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.mycelium/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/tmp/**",
  "**/temp/**",
  "**/vendor/**",
  "**/*.d.ts",
];

const AD_HOC_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  noEmit: true,
};

// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadTypeScriptProject(
  repoRoot: string,
): Promise<TypeScriptProjectLoadResult> {
  const warnings: string[] = [];
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");

  if (await fse.pathExists(tsconfigPath)) {
    const tsconfigResult = loadProgramFromTsconfig(tsconfigPath, repoRoot);
    warnings.push(...tsconfigResult.warnings);
    if (tsconfigResult.project) {
      return { project: tsconfigResult.project, warnings };
    }
  }

  const adHocResult = await loadProgramFromAdHoc(repoRoot);
  warnings.push(...adHocResult.warnings);

  return { project: adHocResult.project, warnings };
}

// =============================================================================
// TSCONFIG RESOLUTION
// =============================================================================

function loadProgramFromTsconfig(
  tsconfigPath: string,
  repoRoot: string,
): TypeScriptProjectLoadResult {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      project: null,
      warnings: [formatDiagnostic(configFile.error, repoRoot)],
    };
  }

  const parseResult = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );

  const warnings = parseResult.errors.map((error) => formatDiagnostic(error, repoRoot));
  if (parseResult.fileNames.length === 0) {
    warnings.push("tsconfig.json produced no TypeScript source files.");
    return { project: null, warnings };
  }

  const program = ts.createProgram({
    rootNames: parseResult.fileNames,
    options: parseResult.options,
  });

  return {
    project: {
      kind: "tsconfig",
      program,
      rootFileNames: parseResult.fileNames,
    },
    warnings,
  };
}

// =============================================================================
// AD-HOC RESOLUTION
// =============================================================================

async function loadProgramFromAdHoc(repoRoot: string): Promise<TypeScriptProjectLoadResult> {
  const files = await fg(AD_HOC_FILE_GLOBS, {
    cwd: repoRoot,
    absolute: true,
    unique: true,
    suppressErrors: true,
    ignore: AD_HOC_FILE_IGNORES,
  });

  files.sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    return { project: null, warnings: [] };
  }

  const program = ts.createProgram({
    rootNames: files,
    options: AD_HOC_COMPILER_OPTIONS,
  });

  return {
    project: {
      kind: "ad-hoc",
      program,
      rootFileNames: files,
    },
    warnings: [],
  };
}

// =============================================================================
// DIAGNOSTIC HELPERS
// =============================================================================

function formatDiagnostic(diagnostic: ts.Diagnostic, repoRoot: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const fileName = toRepoRelativePath(repoRoot, diagnostic.file.fileName);

  return `${fileName}:${line + 1}:${character + 1} ${message}`;
}

// =============================================================================
// PATH HELPERS
// =============================================================================

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return filePath;
  }

  return normalizeRepoPath(relativePath);
}

function normalizeRepoPath(inputPath: string): string {
  const normalized = inputPath.split(path.sep).join("/");
  const withoutDot = normalized.replace(/^\.\/+/, "");
  const withoutLeading = withoutDot.replace(/^\/+/, "");
  return withoutLeading.replace(/\/+$/, "");
}
