/**
 * ValidationPipeline unit tests.
 * Purpose: lock normalization for missing reports and doctor canary handling.
 * Assumptions: validator runner is stubbed; MYCELIUM_HOME is isolated per test.
 * Usage: npm test -- src/app/orchestrator/validation/validation-pipeline.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlLogger } from "../../../core/logger.js";
import { createPathsContext, type PathsContext } from "../../../core/paths.js";
import type { TaskSpec } from "../../../core/task-manifest.js";
import type { DoctorCanaryResult } from "../../../validators/doctor-validator.js";
import type { ValidatorRunner } from "../ports.js";

import { ValidationPipeline } from "./validation-pipeline.js";

// =============================================================================
// HELPERS
// =============================================================================

function buildTaskSpec(id: string, name: string): TaskSpec {
  return {
    manifest: {
      id,
      name,
      description: "validation pipeline test task",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "true" },
    },
    taskDirName: `${id}-${name}`,
    stage: "legacy",
    slug: name,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("ValidationPipeline", () => {
  let tmpDir: string;
  let paths: PathsContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "validation-pipeline-"));
    paths = createPathsContext({ myceliumHome: path.join(tmpDir, ".mycelium") });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("normalizes missing test reports into an error result", async () => {
    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-1" });
    const runner: ValidatorRunner = {
      runTestValidator: async () => null,
      runStyleValidator: async () => null,
      runArchitectureValidator: async () => null,
      runDoctorValidator: async () => null,
    };

    const pipeline = new ValidationPipeline({
      projectName: "demo",
      repoPath: tmpDir,
      runId: "run-1",
      tasksRoot: path.join(tmpDir, "tasks"),
      mainBranch: "main",
      paths,
      validators: {
        test: {
          config: { enabled: true, mode: "warn", provider: "mock", model: "mock" },
          mode: "warn",
          enabled: true,
        },
        style: { config: undefined, mode: "off", enabled: false },
        architecture: { config: undefined, mode: "off", enabled: false },
        doctor: { config: undefined, mode: "off", enabled: false },
        doctorCanary: { mode: "off", env_var: "ORCH_CANARY", warn_on_unexpected_pass: true },
      },
      orchestratorLog,
      runner,
    });

    try {
      const outcome = await pipeline.runForTask({
        task: buildTaskSpec("001", "missing-report"),
        workspacePath: tmpDir,
        logsDir: path.join(tmpDir, "logs"),
      });

      expect(outcome.results).toHaveLength(1);
      expect(outcome.blocked).toHaveLength(0);
      expect(outcome.results[0]?.validator).toBe("test");
      expect(outcome.results[0]?.status).toBe("error");
      expect(outcome.results[0]?.summary).toBe(
        "Test validator returned no result (see validator log).",
      );
      expect(outcome.results[0]?.reportPath).toBeNull();
    } finally {
      pipeline.close();
      orchestratorLog.close();
    }
  });

  it("treats unexpected doctor canary passes as failures in block mode", async () => {
    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-2" });
    const runner: ValidatorRunner = {
      runTestValidator: async () => null,
      runStyleValidator: async () => null,
      runArchitectureValidator: async () => null,
      runDoctorValidator: async () => ({
        effective: true,
        coverage_assessment: "good",
        concerns: [],
        recommendations: [],
        confidence: "high",
      }),
    };
    const doctorCanary: DoctorCanaryResult = {
      status: "unexpected_pass",
      exitCode: 0,
      output: "doctor ok",
      envVar: "ORCH_CANARY",
    };

    const pipeline = new ValidationPipeline({
      projectName: "demo",
      repoPath: tmpDir,
      runId: "run-2",
      tasksRoot: path.join(tmpDir, "tasks"),
      mainBranch: "main",
      paths,
      validators: {
        test: { config: undefined, mode: "off", enabled: false },
        style: { config: undefined, mode: "off", enabled: false },
        architecture: { config: undefined, mode: "off", enabled: false },
        doctor: {
          config: {
            enabled: true,
            mode: "block",
            provider: "mock",
            model: "mock",
            run_every_n_tasks: 1,
          },
          mode: "block",
          enabled: true,
        },
        doctorCanary: { mode: "env", env_var: "ORCH_CANARY", warn_on_unexpected_pass: true },
      },
      orchestratorLog,
      runner,
    });

    try {
      const outcome = await pipeline.runDoctorValidation({
        doctorCommand: "echo ok",
        doctorCanary,
        trigger: "doctor_canary_failed",
        triggerNotes: "Unexpected canary pass",
      });

      expect(outcome).not.toBeNull();
      expect(outcome?.result.status).toBe("fail");
      expect(outcome?.result.trigger).toBe("doctor_canary_failed");
      expect(outcome?.result.summary).toContain("Canary: unexpected pass");
      expect(outcome?.blocked).not.toBeNull();
      expect(outcome?.blocked?.reason).toContain("Doctor validator blocked merge");
      if (outcome?.result.summary) {
        expect(outcome?.blocked?.reason).toContain(outcome.result.summary);
      }
    } finally {
      pipeline.close();
      orchestratorLog.close();
    }
  });
});
