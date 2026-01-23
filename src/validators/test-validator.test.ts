import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ValidatorConfig } from "../core/config.js";
import { JsonlLogger } from "../core/logger.js";
import { validatorLogPath, validatorReportPath } from "../core/paths.js";
import type { TaskSpec } from "../core/task-manifest.js";
import type { LlmClient, LlmCompletionResult } from "../llm/client.js";
import { runTestValidator } from "./test-validator.js";

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

describe("runTestValidator", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "test-validator-"));
    originalHome = process.env.MYCELIUM_HOME;
    process.env.MYCELIUM_HOME = path.join(tmpDir, ".mycelium");
  });

  afterEach(async () => {
    process.env.MYCELIUM_HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it("captures changed tests, calls the LLM, and writes reports", async () => {
    const repoPath = path.join(tmpDir, "repo");
    await fse.ensureDir(repoPath);

    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["checkout", "-B", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "tester"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repoPath });

    await fse.outputFile(path.join(repoPath, "src", "app.ts"), "export const add = (a, b) => a + b;");
    await fse.outputFile(
      path.join(repoPath, "tests", "app.test.ts"),
      "describe('add', () => { it('works', () => {}); });",
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "init"], { cwd: repoPath });

    await execa("git", ["checkout", "-b", "agent/001-add-tests"], { cwd: repoPath });
    await fse.outputFile(
      path.join(repoPath, "tests", "app.test.ts"),
      [
        "import { add } from '../src/app';",
        "",
        "describe('add', () => {",
        "  it('adds numbers', () => {",
        "    expect(add(1, 2)).toBe(3);",
        "  });",
        "});",
      ].join("\n"),
    );
    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      ["export const add = (a, b) => {", "  return a + b;", "};", ""].join("\n"),
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "Add tests"], { cwd: repoPath });

    const taskDir = path.join(repoPath, ".tasks", "001-add-tests");
    const manifestPath = path.join(taskDir, "manifest.json");
    const specPath = path.join(taskDir, "spec.md");
    await fse.ensureDir(taskDir);
    await fse.writeJson(manifestPath, {
      id: "001",
      name: "add-tests",
      description: "Add coverage for add()",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: ["src/app.ts"] },
      affected_tests: ["tests/app.test.ts"],
      verify: { doctor: "npm test" },
    });
    await fse.writeFile(specPath, "# 001 — Add coverage\n\nAdd tests for add().");

    const task: TaskSpec = {
      manifest: await fse.readJson(manifestPath),
      taskDir,
      manifestPath,
      specPath,
      slug: "add-tests",
    };

    const taskLogsDir = path.join(tmpDir, "logs");
    await fse.ensureDir(taskLogsDir);
    await fse.writeFile(path.join(taskLogsDir, "doctor-001.log"), "PASS add suite");

    const validatorConfig: ValidatorConfig = {
      enabled: true,
      mode: "warn",
      provider: "openai",
      model: "o3",
    };
    const llm = new FakeLlm({
      pass: true,
      summary: "Tests look meaningful.",
      concerns: [],
      coverage_gaps: [],
      confidence: "high",
    });

    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-1" });
    const result = await runTestValidator({
      projectName: "demo",
      repoPath,
      runId: "run-1",
      task,
      taskSlug: task.slug,
      workspacePath: repoPath,
      taskLogsDir,
      mainBranch: "main",
      config: validatorConfig,
      orchestratorLog,
      llmClient: llm,
    });
    orchestratorLog.close();

    expect(result).not.toBeNull();
    expect(result?.pass).toBe(true);
    expect(result?.summary).toContain("meaningful");
    expect(llm.lastPrompt).toContain("tests/app.test.ts");
    expect(llm.lastPrompt).toContain("src/app.ts");

    const reportPath = validatorReportPath(
      "demo",
      "run-1",
      "test-validator",
      task.manifest.id,
      task.slug,
    );
    const report = await fse.readJson(reportPath);
    expect(report.result.pass).toBe(true);
    expect(report.meta.changed_tests).toContain("tests/app.test.ts");

    const logPath = validatorLogPath("demo", "run-1", "test-validator");
    const logContent = await fse.readFile(logPath, "utf8");
    expect(logContent).toContain("validation.analysis");
  });
});
