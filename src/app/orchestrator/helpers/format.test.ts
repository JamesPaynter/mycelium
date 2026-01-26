import { describe, expect, it } from "vitest";

import type { DoctorCanaryResult } from "../../../validators/doctor-validator.js";

import {
  buildDoctorCanarySummary,
  formatDoctorCanaryEnvVar,
  formatDoctorCanarySummary,
  limitText,
} from "./format.js";

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
