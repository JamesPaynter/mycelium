import { describe, expect, it } from "vitest";

import {
  computeChecksetDecision,
  resolveDoctorCommandForChecksetMode,
} from "../control-plane/policy/checkset.js";

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane checkset policy", () => {
  it("uses the scoped command for a mapped component in enforce mode", () => {
    const decision = computeChecksetDecision({
      touchedComponents: ["component-a"],
      impactedComponents: ["component-a"],
      commandsByComponent: { "component-a": "npm run test:component-a" },
      maxComponentsForScoped: 3,
      fallbackCommand: "npm test",
    });

    const doctorCommand = resolveDoctorCommandForChecksetMode({
      mode: "enforce",
      decision,
      defaultDoctorCommand: "npm test",
    });

    expect(decision.is_fallback).toBe(false);
    expect(decision.selected_command).toBe("npm run test:component-a");
    expect(doctorCommand).toBe("npm run test:component-a");
  });

  it("falls back when a required component mapping is missing", () => {
    const decision = computeChecksetDecision({
      touchedComponents: ["component-a", "component-b"],
      impactedComponents: ["component-a", "component-b"],
      commandsByComponent: { "component-a": "npm run test:component-a" },
      maxComponentsForScoped: 3,
      fallbackCommand: "npm test",
    });

    expect(decision.is_fallback).toBe(true);
    expect(decision.selected_command).toBe("npm test");
    expect(decision.fallback_reason).toBe("missing_command_mapping");
    expect(decision.required_components).toEqual(["component-a", "component-b"]);
  });

  it("falls back when a surface change is detected", () => {
    const decision = computeChecksetDecision({
      touchedComponents: ["component-a"],
      impactedComponents: ["component-a", "component-b"],
      commandsByComponent: {
        "component-a": "npm run test:component-a",
        "component-b": "npm run test:component-b",
      },
      maxComponentsForScoped: 3,
      fallbackCommand: "npm test",
      surfaceChange: true,
      surfaceChangeCategories: ["contract"],
    });

    expect(decision.is_fallback).toBe(false);
    expect(decision.required_components).toEqual(["component-a", "component-b"]);
    expect(decision.selected_command).toBe("npm run test:component-a && npm run test:component-b");
    expect(decision.rationale).toContain("surface_change:contract");
  });

  it("falls back on surface changes when no impact data is available", () => {
    const decision = computeChecksetDecision({
      touchedComponents: ["component-a"],
      commandsByComponent: { "component-a": "npm run test:component-a" },
      maxComponentsForScoped: 3,
      fallbackCommand: "npm test",
      surfaceChange: true,
    });

    expect(decision.is_fallback).toBe(true);
    expect(decision.selected_command).toBe("npm test");
    expect(decision.fallback_reason).toBe("surface_change");
  });
});
