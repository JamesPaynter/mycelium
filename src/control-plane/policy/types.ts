// Shared control plane policy types.
// Purpose: keep policy payload shapes consistent across detectors and decisions.


// =============================================================================
// SURFACE CHANGE DETECTION
// =============================================================================

export type SurfaceChangeCategory = "contract" | "config" | "migration" | "public-entrypoint";

export type SurfaceChangeDetection = {
  is_surface_change: boolean;
  categories: SurfaceChangeCategory[];
  matched_files: Partial<Record<SurfaceChangeCategory, string[]>>;
  matched_components?: string[];
  matched_components_by_category?: Partial<Record<SurfaceChangeCategory, string[]>>;
};

export type SurfacePatternConfig = Partial<Record<SurfaceChangeCategory, string[]>>;

export type SurfacePatternSet = Record<SurfaceChangeCategory, string[]>;


// =============================================================================
// AUTONOMY TIERS
// =============================================================================

export type AutonomyTier = 0 | 1 | 2 | 3;

export type PolicyBlastConfidence = "high" | "medium" | "low";

export type PolicyBlastRadius = {
  touched: number;
  impacted: number;
  confidence: PolicyBlastConfidence;
};

export type PolicyCheckMode = "off" | "report" | "enforce";

export type PolicyCheckSelection = {
  mode: PolicyCheckMode;
  selected_command: string;
  rationale: string[];
};

export type PolicyLocks = {
  reads: string[];
  writes: string[];
};

export type PolicyDecision = {
  tier: AutonomyTier;
  surface_change: boolean;
  blast_radius: PolicyBlastRadius;
  checks: PolicyCheckSelection;
  locks: {
    declared: PolicyLocks;
    derived?: PolicyLocks;
  };
};
