import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import { minimatch } from "minimatch";

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
import { resolveTypeScriptSymbolReferences } from "../../../control-plane/extract/symbols-ts/refs.js";
import { listChangedPaths } from "../../../control-plane/git.js";
import {
  buildBlastRadiusReport,
  type ControlPlaneBlastRadiusReport,
} from "../../../control-plane/integration/blast-radius.js";
import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../../../control-plane/integration/derived-scope.js";
import {
  buildControlPlaneModel,
  getControlPlaneModelInfo,
} from "../../../control-plane/model/build.js";
import type {
  ControlPlaneModel,
  ControlPlaneSymbolDefinition,
  ControlPlaneSymbolReference,
} from "../../../control-plane/model/schema.js";
import {
  evaluateTaskPolicyDecision,
  type ChecksetReport,
  type PolicyChecksetConfig,
} from "../../../control-plane/policy/eval.js";
import { resolveSurfacePatterns } from "../../../control-plane/policy/surface-detect.js";
import type {
  PolicyDecision,
  SurfaceChangeDetection,
  SurfacePatternSet,
} from "../../../control-plane/policy/types.js";
import { ControlPlaneBuildLockError, ControlPlaneStore } from "../../../control-plane/storage.js";
import { loadProjectConfig } from "../../../core/config-loader.js";
import type { ProjectConfig } from "../../../core/config.js";
import {
  TaskManifestSchema,
  formatManifestIssues,
  normalizeTaskManifest,
  type TaskManifest,
} from "../../../core/task-manifest.js";

import { registerBlastRadiusCommand } from "./blast-radius.js";
import { registerComponentsCommands } from "./components.js";
import { registerDependencyCommands } from "./deps.js";

const MODEL_NOT_BUILT_MESSAGE =
  "Control plane model not built. Run `mycelium cp build` to generate it.";

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
  const controlPlane = program
    .command("control-plane")
    .alias("cp")
    .description("Repository navigation surface for agents");

  registerControlPlaneFlags(controlPlane);

  const sharedContext: ControlPlaneCommandContext = {
    modelNotBuiltMessage: MODEL_NOT_BUILT_MESSAGE,
    resolveCommandContext,
    loadControlPlaneModel,
    emitControlPlaneResult,
    emitControlPlaneError,
    emitModelNotBuiltError,
    resolveModelStoreError,
  };

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

  registerComponentsCommands(controlPlane, sharedContext);
  registerDependencyCommands(controlPlane, sharedContext);
  registerBlastRadiusCommand(controlPlane, sharedContext);

  const policy = controlPlane.command("policy").description("Policy evaluation queries");

  policy
    .command("eval")
    .description("Evaluate policy decisions for a change set")
    .option("--changed <paths...>", "Paths to treat as changed")
    .option("--diff <range>", "Git diff rev range (e.g., HEAD~1..HEAD)")
    .option("--against <ref>", "Git ref to diff against HEAD")
    .option("--manifest <path>", "Task manifest JSON to evaluate")
    .action(async (opts, command) => {
      await handlePolicyEval(opts as PolicyEvalOptions, command);
    });

  const symbols = controlPlane.command("symbols").description("Symbol navigation queries");

  symbols
    .command("find")
    .description("Search for symbols")
    .argument("[query...]", "Search terms")
    .option("--kind <kind...>", "Filter by symbol kind")
    .option("--component <id>", "Filter by component id")
    .option("--path <glob>", "Filter by file path glob")
    .option("--limit <n>", "Limit number of matches (default: 50)", (value) => parseInt(value, 10))
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
    .argument("<symbol_id>", "Symbol id")
    .option("--limit <n>", "Limit number of references (default: 50)", (value) =>
      parseInt(value, 10),
    )
    .option("--include-definition", "Include definition references", false)
    .option("--group-by <mode>", "Group references by component or file")
    .action(async (symbolId, opts, command) => {
      await handleSymbolsRefs(String(symbolId), opts as SymbolRefsOptions, command);
    });
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
    message: "Control plane command failed.",
    details: null,
  };
}

// =============================================================================
// POLICY EVAL
// =============================================================================

type PolicyEvalOptions = {
  changed?: string[];
  diff?: string;
  against?: string;
  manifest?: string;
};

type PolicyEvalManifestSource = "file" | "synthetic";

type PolicyEvalConfigSource = "explicit" | "repo" | "defaults";

type PolicyEvalRequiredChecks = {
  mode: PolicyChecksetConfig["mode"];
  selected_command: string;
  rationale: string[];
  fallback_reason?: ChecksetReport["fallback_reason"];
  confidence: ChecksetReport["confidence"];
};

type PolicyEvalControlPlaneSummary = {
  enabled: boolean;
  config_source: PolicyEvalConfigSource;
  config_path: string | null;
  component_resource_prefix: string;
  fallback_resource: string;
  checks: {
    mode: PolicyChecksetConfig["mode"];
    max_components_for_scoped: number;
    fallback_command: string | null;
    commands_by_component: Record<string, string>;
  };
  surface_patterns: SurfacePatternSet;
  surface_locks_enabled: boolean;
};

type PolicyEvalOutput = {
  base_sha: string;
  diff: string | null;
  against: string | null;
  changed_files: string[];
  manifest: {
    source: PolicyEvalManifestSource;
    path: string | null;
    task_id: string;
    task_name: string;
  };
  control_plane: PolicyEvalControlPlaneSummary;
  lock_derivation: DerivedScopeReport;
  blast_radius: ControlPlaneBlastRadiusReport;
  surface_detection: SurfaceChangeDetection;
  tier: PolicyDecision["tier"];
  required_checks: PolicyEvalRequiredChecks;
  policy: PolicyDecision;
  checkset: {
    mode: PolicyChecksetConfig["mode"];
    report: ChecksetReport;
    doctor_command: string;
    default_doctor_command: string;
  };
};

type PolicyEvalResolvedConfig = {
  configSource: PolicyEvalConfigSource;
  configPath: string | null;
  controlPlaneEnabled: boolean;
  componentResourcePrefix: string;
  fallbackResource: string;
  checksConfig: PolicyChecksetConfig;
  surfacePatterns: SurfacePatternSet;
  surfaceLocksEnabled: boolean;
  defaultDoctorCommand: string;
};

class PolicyEvalInputError extends Error {
  details: Record<string, unknown> | null;

  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.details = details;
  }
}

async function handlePolicyEval(options: PolicyEvalOptions, command: Command): Promise<void> {
  const { flags, output } = resolveCommandContext(command);

  let modelResult: { model: ControlPlaneModel; baseSha: string } | null = null;
  try {
    modelResult = await loadControlPlaneModel({
      repoRoot: flags.repoPath,
      baseSha: flags.revision.baseSha,
      ref: flags.revision.ref,
      shouldBuild: flags.shouldBuild,
    });
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
    return;
  }

  if (!modelResult) {
    emitModelNotBuiltError(MODEL_NOT_BUILT_MESSAGE, output);
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
    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolvePolicyEvalError(error), output);
  }
}

async function buildPolicyEvalOutput(input: {
  repoPath: string;
  baseSha: string;
  model: ControlPlaneModel;
  options: PolicyEvalOptions;
  configPath: string | null;
}): Promise<PolicyEvalOutput> {
  const changedInput = normalizeChangedList(input.options.changed);
  const diff = normalizeOptionalString(input.options.diff);
  const against = normalizeOptionalString(input.options.against);

  if (changedInput.length === 0 && !diff && !against) {
    throw new PolicyEvalInputError("Provide --changed, --diff, or --against to evaluate policy.");
  }

  const changedFiles = await listChangedPaths({
    repoRoot: input.repoPath,
    changed: changedInput.length > 0 ? changedInput : null,
    diff,
    against,
  });

  if (changedFiles.length === 0) {
    throw new PolicyEvalInputError("No changed files found for policy evaluation.", {
      diff,
      against,
      changed: changedInput,
    });
  }

  const resolvedConfig = resolvePolicyEvalConfig({
    repoPath: input.repoPath,
    explicitConfigPath: input.configPath,
  });

  const manifestResult = await resolvePolicyEvalManifest({
    manifestPath: normalizeOptionalString(input.options.manifest),
    changedFiles,
    defaultDoctorCommand: resolvedConfig.defaultDoctorCommand,
  });

  const lockDerivation = await computeLockDerivationReport({
    manifest: manifestResult.manifest,
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    model: input.model,
    config: resolvedConfig,
  });

  const blastReport = buildBlastRadiusReport({
    task: manifestResult.manifest,
    baseSha: input.baseSha,
    changedFiles,
    model: input.model,
  });

  const policyEval = evaluateTaskPolicyDecision({
    task: manifestResult.manifest,
    derivedScopeReport: lockDerivation,
    componentResourcePrefix: resolvedConfig.componentResourcePrefix,
    fallbackResource: resolvedConfig.fallbackResource,
    model: input.model,
    checksConfig: resolvedConfig.checksConfig,
    defaultDoctorCommand: manifestResult.manifest.verify.doctor,
    surfacePatterns: resolvedConfig.surfacePatterns,
  });

  const requiredChecks: PolicyEvalRequiredChecks = {
    mode: policyEval.policyDecision.checks.mode,
    selected_command: policyEval.policyDecision.checks.selected_command,
    rationale: policyEval.policyDecision.checks.rationale,
    fallback_reason: policyEval.checksetReport.fallback_reason,
    confidence: policyEval.checksetReport.confidence,
  };

  return {
    base_sha: input.baseSha,
    diff,
    against,
    changed_files: changedFiles,
    manifest: {
      source: manifestResult.source,
      path: manifestResult.path,
      task_id: manifestResult.manifest.id,
      task_name: manifestResult.manifest.name,
    },
    control_plane: {
      enabled: resolvedConfig.controlPlaneEnabled,
      config_source: resolvedConfig.configSource,
      config_path: resolvedConfig.configPath,
      component_resource_prefix: resolvedConfig.componentResourcePrefix,
      fallback_resource: resolvedConfig.fallbackResource,
      checks: {
        mode: resolvedConfig.checksConfig.mode,
        max_components_for_scoped: resolvedConfig.checksConfig.maxComponentsForScoped,
        fallback_command: resolvedConfig.checksConfig.fallbackCommand ?? null,
        commands_by_component: resolvedConfig.checksConfig.commandsByComponent,
      },
      surface_patterns: resolvedConfig.surfacePatterns,
      surface_locks_enabled: resolvedConfig.surfaceLocksEnabled,
    },
    lock_derivation: lockDerivation,
    blast_radius: blastReport,
    surface_detection: policyEval.surfaceDetection,
    tier: policyEval.policyDecision.tier,
    required_checks: requiredChecks,
    policy: policyEval.policyDecision,
    checkset: {
      mode: policyEval.policyDecision.checks.mode,
      report: policyEval.checksetReport,
      doctor_command: policyEval.doctorCommand,
      default_doctor_command: manifestResult.manifest.verify.doctor,
    },
  };
}

async function computeLockDerivationReport(input: {
  manifest: TaskManifest;
  repoPath: string;
  baseSha: string;
  model: ControlPlaneModel;
  config: PolicyEvalResolvedConfig;
}): Promise<DerivedScopeReport> {
  const snapshot = await createDerivedScopeSnapshot({
    repoPath: input.repoPath,
    baseSha: input.baseSha,
  });

  try {
    return await deriveTaskWriteScopeReport({
      manifest: input.manifest,
      model: input.model,
      snapshotPath: snapshot.snapshotPath,
      componentResourcePrefix: input.config.componentResourcePrefix,
      fallbackResource: input.config.fallbackResource,
      surfaceLocksEnabled: input.config.surfaceLocksEnabled,
      surfacePatterns: input.config.surfacePatterns,
    });
  } finally {
    await snapshot.release();
  }
}

async function resolvePolicyEvalManifest(input: {
  manifestPath: string | null;
  changedFiles: string[];
  defaultDoctorCommand: string;
}): Promise<{ manifest: TaskManifest; source: PolicyEvalManifestSource; path: string | null }> {
  if (input.manifestPath) {
    const manifest = await loadTaskManifestFromPath(input.manifestPath);
    return {
      manifest,
      source: "file",
      path: path.resolve(input.manifestPath),
    };
  }

  const manifest = buildSyntheticManifest({
    changedFiles: input.changedFiles,
    doctorCommand: input.defaultDoctorCommand,
  });

  return { manifest, source: "synthetic", path: null };
}

async function loadTaskManifestFromPath(manifestPath: string): Promise<TaskManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new PolicyEvalInputError("Failed to read manifest file.", {
      manifest_path: manifestPath,
      message: formatErrorMessage(error),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new PolicyEvalInputError("Manifest JSON is invalid.", {
      manifest_path: manifestPath,
      message: formatErrorMessage(error),
    });
  }

  const parsed = TaskManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new PolicyEvalInputError("Manifest schema validation failed.", {
      manifest_path: manifestPath,
      issues: formatManifestIssues(parsed.error.issues),
    });
  }

  return normalizeTaskManifest(parsed.data);
}

function buildSyntheticManifest(input: {
  changedFiles: string[];
  doctorCommand: string;
}): TaskManifest {
  return normalizeTaskManifest({
    id: "policy-eval",
    name: "Policy eval",
    description: "Synthetic manifest for policy evaluation.",
    estimated_minutes: 1,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: input.changedFiles },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: input.doctorCommand },
  });
}

function resolvePolicyEvalConfig(input: {
  repoPath: string;
  explicitConfigPath: string | null;
}): PolicyEvalResolvedConfig {
  const explicitPath = input.explicitConfigPath ? path.resolve(input.explicitConfigPath) : null;
  if (explicitPath) {
    if (!fsSync.existsSync(explicitPath)) {
      throw new PolicyEvalInputError("Project config not found.", {
        config_path: explicitPath,
      });
    }

    const config = loadProjectConfig(explicitPath);
    return buildPolicyEvalConfigFromProject({
      config,
      configSource: "explicit",
      configPath: explicitPath,
    });
  }

  const repoConfigPath = path.join(input.repoPath, ".mycelium", "config.yaml");
  if (fsSync.existsSync(repoConfigPath)) {
    const config = loadProjectConfig(repoConfigPath);
    return buildPolicyEvalConfigFromProject({
      config,
      configSource: "repo",
      configPath: repoConfigPath,
    });
  }

  return {
    configSource: "defaults",
    configPath: null,
    controlPlaneEnabled: false,
    componentResourcePrefix: "component:",
    fallbackResource: "repo-root",
    checksConfig: {
      mode: "off",
      commandsByComponent: {},
      maxComponentsForScoped: 3,
    },
    surfacePatterns: resolveSurfacePatterns(),
    surfaceLocksEnabled: false,
    defaultDoctorCommand: "npm test",
  };
}

function buildPolicyEvalConfigFromProject(input: {
  config: ProjectConfig;
  configSource: PolicyEvalConfigSource;
  configPath: string;
}): PolicyEvalResolvedConfig {
  const checks = input.config.control_plane.checks;
  return {
    configSource: input.configSource,
    configPath: input.configPath,
    controlPlaneEnabled: input.config.control_plane.enabled,
    componentResourcePrefix: input.config.control_plane.component_resource_prefix,
    fallbackResource: input.config.control_plane.fallback_resource,
    checksConfig: {
      mode: checks.mode,
      commandsByComponent: sortRecord(checks.commands_by_component ?? {}),
      maxComponentsForScoped: checks.max_components_for_scoped,
      fallbackCommand: checks.fallback_command,
    },
    surfacePatterns: resolveSurfacePatterns(input.config.control_plane.surface_patterns),
    surfaceLocksEnabled: input.config.control_plane.surface_locks?.enabled ?? false,
    defaultDoctorCommand: input.config.doctor,
  };
}

function resolvePolicyEvalError(error: unknown): ControlPlaneJsonError {
  if (error instanceof PolicyEvalInputError) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
      message: error.message,
      details: { name: error.name },
    };
  }

  return {
    code: CONTROL_PLANE_ERROR_CODES.policyEvalError,
    message: "Policy evaluation failed.",
    details: null,
  };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeChangedList(changed?: string[]): string[] {
  if (!changed || changed.length === 0) {
    return [];
  }

  return changed.map((value) => value.trim()).filter((value) => value.length > 0);
}

function normalizeOptionalString(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveGlobalConfigPath(command: Command): string | null {
  const globals = command.optsWithGlobals() as { config?: string };
  return globals.config ? String(globals.config) : null;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
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

async function handleSymbolsFind(
  queryParts: string[] | string,
  options: SymbolFindOptions,
  command: Command,
): Promise<void> {
  const { flags, output } = resolveCommandContext(command);

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
  const { flags, output } = resolveCommandContext(command);

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

    emitControlPlaneResult(result, output);
  } catch (error) {
    emitControlPlaneError(resolveModelStoreError(error), output);
  }
}

async function handleSymbolsRefs(
  symbolId: string,
  options: SymbolRefsOptions,
  command: Command,
): Promise<void> {
  const { flags, output } = resolveCommandContext(command);

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
    const definition = definitions.find((entry) => entry.symbol_id === normalizedId) ?? null;

    const limit = normalizeLimit(options.limit, 50);
    const groupBy = normalizeGroupBy(options.groupBy);
    const includeDefinition = options.includeDefinition ?? false;

    if (!definition) {
      emitControlPlaneResult(
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
      emitControlPlaneError(
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

    emitControlPlaneResult(
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
