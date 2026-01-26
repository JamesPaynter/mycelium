import { describe, expect, it } from "vitest";

import { classifyAutonomyTier } from "../control-plane/policy/tier.js";

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane autonomy tiering", () => {
  it("returns tier 0 for low blast radius without surface change", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: [],
      impactedComponentCount: 1,
      touchedComponentCount: 1,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(0);
  });

  it("returns tier 1 for moderate blast radius without surface change", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: [],
      impactedComponentCount: 2,
      touchedComponentCount: 2,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(1);
  });

  it("returns tier 2 for surface changes", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: ["contract"],
      impactedComponentCount: 1,
      touchedComponentCount: 1,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(2);
  });

  it("returns tier 2 for large blast radius", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: [],
      impactedComponentCount: 4,
      touchedComponentCount: 4,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(2);
  });

  it("returns tier 3 for migration surface changes", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: ["migration"],
      impactedComponentCount: 1,
      touchedComponentCount: 1,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(3);
  });

  it("returns tier 3 for config + contract surface combos", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: ["config", "contract"],
      impactedComponentCount: 1,
      touchedComponentCount: 1,
      hasRepoRootFallback: false,
    });

    expect(tier).toBe(3);
  });

  it("returns tier 3 when repo-root fallback and wide impact", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: [],
      impactedComponentCount: 4,
      touchedComponentCount: 2,
      hasRepoRootFallback: true,
    });

    expect(tier).toBe(3);
  });

  it("returns tier 2 when repo-root fallback without wide impact", () => {
    const tier = classifyAutonomyTier({
      surfaceCategories: [],
      impactedComponentCount: 2,
      touchedComponentCount: 2,
      hasRepoRootFallback: true,
    });

    expect(tier).toBe(2);
  });
});
