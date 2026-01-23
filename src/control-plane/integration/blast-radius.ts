// Control plane blast radius integration.
// Purpose: compute component blast radius for task diffs with conservative widening.
// Assumes repo-relative paths use forward slashes.

import type { TaskManifest } from "../../core/task-manifest.js";
import {
  WARNING_LOW,
  WARNING_MISSING_DEPS,
  WARNING_UNMAPPED,
  computeBlastRadius as computeBlastRadiusFromPaths,
  type ControlPlaneBlastConfidence,
} from "../blast.js";
import type { ControlPlaneModel } from "../model/schema.js";

export type ControlPlaneBlastWideningReason =
  | "unmapped_paths"
  | "missing_dependency_graph"
  | "low_confidence_edges";

export type ControlPlaneBlastRadiusResult = {
  touched_components: string[];
  impacted_components: string[];
  confidence: ControlPlaneBlastConfidence;
  widening_reasons: ControlPlaneBlastWideningReason[];
};

export type ControlPlaneBlastRadiusInput = {
  baseSha: string;
  changedFiles: string[];
  model: ControlPlaneModel;
};

export type ControlPlaneBlastRadiusReport = {
  task_id: string;
  task_name: string;
  base_sha: string;
  changed_files: string[];
  touched_components: string[];
  impacted_components: string[];
  confidence: ControlPlaneBlastConfidence;
  widening_reasons: ControlPlaneBlastWideningReason[];
  unmapped_paths: string[];
};



// =============================================================================
// PUBLIC API
// =============================================================================

export function computeBlastRadius(
  input: ControlPlaneBlastRadiusInput,
): ControlPlaneBlastRadiusResult {
  const blast = computeBlastRadiusFromPaths({
    changedPaths: input.changedFiles,
    model: input.model,
  });

  return {
    touched_components: blast.touched_components,
    impacted_components: blast.impacted_components,
    confidence: blast.confidence,
    widening_reasons: mapWarningsToReasons(blast.warnings),
  };
}

export function buildBlastRadiusReport(input: {
  task: TaskManifest;
  baseSha: string;
  changedFiles: string[];
  model: ControlPlaneModel;
}): ControlPlaneBlastRadiusReport {
  const blast = computeBlastRadiusFromPaths({
    changedPaths: input.changedFiles,
    model: input.model,
  });

  return {
    task_id: input.task.id,
    task_name: input.task.name,
    base_sha: input.baseSha,
    changed_files: blast.changed_paths,
    touched_components: blast.touched_components,
    impacted_components: blast.impacted_components,
    confidence: blast.confidence,
    widening_reasons: mapWarningsToReasons(blast.warnings),
    unmapped_paths: blast.unmapped_paths,
  };
}



// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function mapWarningsToReasons(
  warnings: string[],
): ControlPlaneBlastWideningReason[] {
  const reasons = new Set<ControlPlaneBlastWideningReason>();

  for (const warning of warnings) {
    if (warning === WARNING_UNMAPPED) {
      reasons.add("unmapped_paths");
      continue;
    }

    if (warning === WARNING_MISSING_DEPS) {
      reasons.add("missing_dependency_graph");
      continue;
    }

    if (warning === WARNING_LOW) {
      reasons.add("low_confidence_edges");
    }
  }

  return Array.from(reasons).sort();
}
