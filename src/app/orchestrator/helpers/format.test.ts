import { describe, expect, it } from "vitest";

import type { ArchitectureValidationReport } from "../../../validators/architecture-validator.js";
import type { DoctorCanaryResult, DoctorValidationReport } from "../../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../../validators/style-validator.js";
import type { TestValidationReport } from "../../../validators/test-validator.js";

import {
  buildDoctorCanarySummary,
  formatDoctorCanaryEnvVar,
  formatDoctorCanarySummary,
  limitText,
  summarizeArchitectureReport,
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "./format.js";

describe("summarizeTestReport", () => {
  it("includes concerns and coverage gaps counts", () => {
    const report: TestValidationReport = {
      pass: true,
      summary: "All good",
      concerns: [{ file: "src/app.ts", issue: "Missing tests", severity: "low" }],
      coverage_gaps: ["src/app.ts"],
      confidence: "low",
    };

    expect(summarizeTestReport(report)).toBe("All good | Concerns: 1 | Coverage gaps: 1");
  });
});

describe("summarizeStyleReport", () => {
  it("adds concern counts when present", () => {
    const report: StyleValidationReport = {
      pass: true,
      summary: "Clean",
      concerns: [{ file: "src/app.ts", issue: "Spacing", severity: "low" }],
      confidence: "medium",
    };

    expect(summarizeStyleReport(report)).toBe("Clean | Concerns: 1");
  });
});

describe("summarizeArchitectureReport", () => {
  it("adds concern and recommendation counts", () => {
    const report: ArchitectureValidationReport = {
      pass: true,
      summary: "Aligned",
      concerns: [{ issue: "Boundary", severity: "low", evidence: "Import cycle" }],
      recommendations: [{ description: "Split modules", impact: "medium" }],
      confidence: "high",
    };

    expect(summarizeArchitectureReport(report)).toBe("Aligned | Concerns: 1 | Recs: 1");
  });
});

describe("summarizeDoctorReport", () => {
  it("adds canary details when provided", () => {
    const report: DoctorValidationReport = {
      effective: true,
      coverage_assessment: "good",
      concerns: [{ issue: "Edge", severity: "low", evidence: "trace" }],
      recommendations: [{ description: "Tighten", impact: "medium" }],
      confidence: "medium",
    };
    const canary: DoctorCanaryResult = {
      status: "expected_fail",
      exitCode: 2,
      output: "boom",
      envVar: " ORCH_CANARY ",
    };

    expect(summarizeDoctorReport(report, canary)).toBe(
      "Effective: yes | Coverage: good | Concerns: 1 | Recs: 1 | Canary: failed as expected with ORCH_CANARY=1",
    );
  });
});

describe("formatDoctorCanaryEnvVar", () => {
  it("falls back to ORCH_CANARY when empty", () => {
    expect(formatDoctorCanaryEnvVar("   ")).toBe("ORCH_CANARY=1");
  });

  it("trims and formats custom env vars", () => {
    expect(formatDoctorCanaryEnvVar(" MY_CANARY ")).toBe("MY_CANARY=1");
  });
});

describe("formatDoctorCanarySummary", () => {
  it("labels skipped runs with the reason", () => {
    const canary: DoctorCanaryResult = { status: "skipped", reason: "disabled" };
    expect(formatDoctorCanarySummary(canary)).toBe("Canary: skipped (disabled)");
  });

  it("labels unexpected passes", () => {
    const canary: DoctorCanaryResult = {
      status: "unexpected_pass",
      exitCode: 0,
      output: "ok",
      envVar: "CANARY",
    };
    expect(formatDoctorCanarySummary(canary)).toBe("Canary: unexpected pass with CANARY=1");
  });
});

describe("buildDoctorCanarySummary", () => {
  it("returns a skipped summary with the reason", () => {
    const canary: DoctorCanaryResult = {
      status: "skipped",
      reason: "no command",
      envVar: "ORCH_CANARY",
    };

    expect(buildDoctorCanarySummary(canary)).toEqual({
      status: "skipped",
      env_var: "ORCH_CANARY",
      reason: "no command",
    });
  });

  it("returns status and exit code for expected failures", () => {
    const canary: DoctorCanaryResult = {
      status: "expected_fail",
      exitCode: 1,
      output: "boom",
      envVar: "CANARY",
    };

    expect(buildDoctorCanarySummary(canary)).toEqual({
      status: "expected_fail",
      env_var: "CANARY",
      exit_code: 1,
    });
  });
});

describe("limitText", () => {
  it("keeps text when under the limit", () => {
    expect(limitText("short", 10)).toBe("short");
  });

  it("truncates and annotates when over the limit", () => {
    expect(limitText("abcdef", 3)).toBe("abc\n... [truncated]");
  });
});
