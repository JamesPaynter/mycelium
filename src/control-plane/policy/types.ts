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
