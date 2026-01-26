// Control plane autonomy tiers.
// Purpose: collapse risk signals into a minimal tier classification (0-3).

import type { AutonomyTier, SurfaceChangeCategory } from "./types.js";

const MODERATE_IMPACT_COMPONENTS = 2;
const LARGE_IMPACT_COMPONENTS = 4;

// =============================================================================
// PUBLIC API
// =============================================================================

export type AutonomyTierInput = {
  surfaceCategories: SurfaceChangeCategory[];
  impactedComponentCount: number;
  touchedComponentCount: number;
  hasRepoRootFallback: boolean;
};

export function classifyAutonomyTier(input: AutonomyTierInput): AutonomyTier {
  const surfaceCategories = normalizeSurfaceCategories(input.surfaceCategories);
  const impactedCount = normalizeCount(input.impactedComponentCount);
  const touchedCount = normalizeCount(input.touchedComponentCount);
  const effectiveImpact = Math.max(impactedCount, touchedCount);

  const hasSurfaceChange = surfaceCategories.length > 0;
  const hasLargeImpact = effectiveImpact >= LARGE_IMPACT_COMPONENTS;
  const hasModerateImpact = effectiveImpact >= MODERATE_IMPACT_COMPONENTS && !hasLargeImpact;

  if (hasHighRiskSurfaceCombo(surfaceCategories)) {
    return 3;
  }

  if (input.hasRepoRootFallback && hasLargeImpact) {
    return 3;
  }

  if (hasSurfaceChange || hasLargeImpact || input.hasRepoRootFallback) {
    return 2;
  }

  if (hasModerateImpact) {
    return 1;
  }

  return 0;
}

export function shouldForceGlobalChecksForTier(tier: AutonomyTier): boolean {
  return tier >= 2;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function hasHighRiskSurfaceCombo(categories: SurfaceChangeCategory[]): boolean {
  if (categories.includes("migration")) {
    return true;
  }

  return categories.includes("contract") && categories.includes("config");
}

function normalizeSurfaceCategories(categories: SurfaceChangeCategory[]): SurfaceChangeCategory[] {
  const normalized = categories
    .map((category) => category.trim())
    .filter((category) => {
      return category.length > 0;
    });

  return Array.from(new Set(normalized)).sort() as SurfaceChangeCategory[];
}

function normalizeCount(count: number): number {
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }

  return Math.floor(count);
}
