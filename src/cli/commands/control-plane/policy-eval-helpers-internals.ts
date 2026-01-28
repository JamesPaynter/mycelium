import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { formatErrorMessage } from "../../../app/errors/format.js";
import {
  createDerivedScopeSnapshot,
  deriveTaskWriteScopeReport,
  type DerivedScopeReport,
} from "../../../control-plane/integration/derived-scope.js";
import type { ControlPlaneModel } from "../../../control-plane/model/schema.js";
import type { PolicyChecksetConfig } from "../../../control-plane/policy/eval.js";
import { resolveSurfacePatterns } from "../../../control-plane/policy/surface-detect.js";
import type { SurfacePatternSet } from "../../../control-plane/policy/types.js";
import { loadProjectConfig } from "../../../core/config-loader.js";
import type { ProjectConfig } from "../../../core/config.js";
import {
  TaskManifestSchema,
  formatManifestIssues,
  normalizeTaskManifest,
  type TaskManifest,
} from "../../../core/task-manifest.js";

// =============================================================================
// TYPES
// =============================================================================

export type PolicyEvalManifestSource = "file" | "synthetic";

export type PolicyEvalConfigSource = "explicit" | "repo" | "defaults";

export type PolicyEvalResolvedConfig = {
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

export class PolicyEvalInputError extends Error {
  details: Record<string, unknown> | null;

  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.details = details;
  }
}

// =============================================================================
// MANIFEST RESOLUTION
// =============================================================================

export async function resolvePolicyEvalManifest(input: {
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

// =============================================================================
// CONFIG RESOLUTION
// =============================================================================

export function resolvePolicyEvalConfig(input: {
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

// =============================================================================
// LOCK DERIVATION
// =============================================================================

export async function computeLockDerivationReport(input: {
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

// =============================================================================
// INPUT NORMALIZATION
// =============================================================================

export function normalizeChangedList(changed?: string[]): string[] {
  if (!changed || changed.length === 0) {
    return [];
  }

  return changed.map((value) => value.trim()).filter((value) => value.length > 0);
}

export function normalizeOptionalString(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// =============================================================================
// UTILITIES
// =============================================================================

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
