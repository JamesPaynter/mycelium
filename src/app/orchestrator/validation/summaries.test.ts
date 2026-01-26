import { describe, expect, it } from "vitest";

import type { ArchitectureValidationReport } from "../../../validators/architecture-validator.js";
import type {
  DoctorCanaryResult,
  DoctorValidationReport,
} from "../../../validators/doctor-validator.js";
import type { StyleValidationReport } from "../../../validators/style-validator.js";
import type { TestValidationReport } from "../../../validators/test-validator.js";

import {
  summarizeArchitectureReport,
  summarizeDoctorReport,
  summarizeStyleReport,
  summarizeTestReport,
} from "./summaries.js";

describe("validator summary formatters", () => {
  it("formats validator summaries consistently", () => {
    const testReport: TestValidationReport = {
      pass: true,
      summary: "All good",
      concerns: [{ file: "src/app.ts", issue: "Missing tests", severity: "low" }],
      coverage_gaps: ["src/app.ts"],
      confidence: "low",
    };
    const styleReport: StyleValidationReport = {
      pass: true,
      summary: "Clean",
      concerns: [{ file: "src/app.ts", issue: "Spacing", severity: "low" }],
      confidence: "medium",
    };
    const architectureReport: ArchitectureValidationReport = {
      pass: true,
      summary: "Aligned",
      concerns: [{ issue: "Boundary", severity: "low", evidence: "Import cycle" }],
      recommendations: [{ description: "Split modules", impact: "medium" }],
      confidence: "high",
    };
    const doctorReport: DoctorValidationReport = {
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

    const summaries = {
      test: summarizeTestReport(testReport),
      style: summarizeStyleReport(styleReport),
      architecture: summarizeArchitectureReport(architectureReport),
      doctor: summarizeDoctorReport(doctorReport, canary),
    };

    expect(summaries).toMatchInlineSnapshot(`
      {
        "architecture": "Aligned | Concerns: 1 | Recs: 1",
        "doctor": "Effective: yes | Coverage: good | Concerns: 1 | Recs: 1 | Canary: failed as expected with ORCH_CANARY=1",
        "style": "Clean | Concerns: 1",
        "test": "All good | Concerns: 1 | Coverage gaps: 1",
      }
    `);
  });
});
