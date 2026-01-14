import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DoctorValidatorConfig } from "../core/config.js";
import { JsonlLogger } from "../core/logger.js";
import { runLogsDir, validatorLogPath, validatorsLogsDir } from "../core/paths.js";
import type { LlmClient, LlmCompletionResult } from "../llm/client.js";
import { runDoctorValidator } from "./doctor-validator.js";

class FakeLlm implements LlmClient {
  lastPrompt = "";

  constructor(private readonly payload: unknown) {}

  async complete<TParsed = unknown>(prompt: string): Promise<LlmCompletionResult<TParsed>> {
    this.lastPrompt = prompt;
    return {
      text: JSON.stringify(this.payload),
      parsed: this.payload as TParsed,
      finishReason: "stop",
    };
  }
}

describe("runDoctorValidator", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "doctor-validator-"));
    originalHome = process.env.TASK_ORCHESTRATOR_HOME;
    process.env.TASK_ORCHESTRATOR_HOME = path.join(tmpDir, ".task-orchestrator");
  });

  afterEach(async () => {
    process.env.TASK_ORCHESTRATOR_HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it("summarizes doctor runs, calls the LLM, and writes reports", async () => {
    const projectName = "demo";
    const runId = "run-1";
    const repoPath = path.join(tmpDir, "repo");
    await fse.ensureDir(repoPath);

    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["checkout", "-b", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "tester"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repoPath });
    await fse.writeFile(path.join(repoPath, "README.md"), "hello");
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "init"], { cwd: repoPath });
    await execa("git", ["checkout", "-b", "agent/work"], { cwd: repoPath });
    await fse.writeFile(path.join(repoPath, "README.md"), "hello world");
    await execa("git", ["commit", "-am", "Change readme"], { cwd: repoPath });

    const taskLogDir = path.join(runLogsDir(projectName, runId), "tasks", "001-demo-task");
    await fse.ensureDir(taskLogDir);
    await fse.writeFile(path.join(taskLogDir, "doctor-001.log"), "Tests failed: widget broke.");
    await fse.writeFile(path.join(taskLogDir, "doctor-002.log"), "All clear on retry.");

    const doctorEvents = [
      {
        ts: "2024-01-01T00:00:01Z",
        type: "doctor.fail",
        attempt: 1,
        payload: { exit_code: 1, summary: "widget test failed" },
      },
      { ts: "2024-01-01T00:00:02Z", type: "doctor.pass", attempt: 2 },
    ];
    await fse.writeFile(
      path.join(taskLogDir, "events.jsonl"),
      doctorEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const validatorConfig: DoctorValidatorConfig = {
      enabled: true,
      mode: "warn",
      provider: "openai",
      model: "o3",
      run_every_n_tasks: 1,
    };
    const llm = new FakeLlm({
      effective: true,
      coverage_assessment: "partial",
      concerns: [],
      recommendations: [{ description: "Keep monitoring", impact: "low" }],
      confidence: "high",
    });

    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId });
    const result = await runDoctorValidator({
      projectName,
      repoPath,
      runId,
      mainBranch: "main",
      doctorCommand: "npm test",
      trigger: "cadence",
      doctorCanary: { status: "expected_fail", exitCode: 1, output: "canary failed" },
      config: validatorConfig,
      orchestratorLog,
      llmClient: llm,
    });
    orchestratorLog.close();

    expect(result).not.toBeNull();
    expect(result?.effective).toBe(true);
    expect(llm.lastPrompt).toContain("Tests failed");
    expect(llm.lastPrompt).toContain("README.md");
    expect(llm.lastPrompt).toContain("Doctor canary");

    const reportDir = path.join(validatorsLogsDir(projectName, runId), "doctor-validator");
    const reportFiles = await fse.readdir(reportDir);
    expect(reportFiles.length).toBe(1);
    const report = await fse.readJson(path.join(reportDir, reportFiles[0]));
    expect(report.result.effective).toBe(true);
    expect(report.meta.doctor_canary).toEqual({
      status: "expected_fail",
      exitCode: 1,
      output: "canary failed",
    });
    const doctorRunPaths = (report.meta.doctor_runs as Array<{ logPath: string }>).map(
      (run) => run.logPath,
    );
    expect(doctorRunPaths.join(" ")).toContain("doctor-001.log");
    expect(doctorRunPaths.join(" ")).toContain("doctor-002.log");

    const logPath = validatorLogPath(projectName, runId, "doctor-validator");
    const logContent = await fse.readFile(logPath, "utf8");
    expect(logContent).toContain("validation.analysis");
  });
});
