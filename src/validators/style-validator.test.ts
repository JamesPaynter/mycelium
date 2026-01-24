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
import { runStyleValidator } from "./style-validator.js";

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

describe("runStyleValidator", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "style-validator-"));
    originalHome = process.env.MYCELIUM_HOME;
    process.env.MYCELIUM_HOME = path.join(tmpDir, ".mycelium");
  });

  afterEach(async () => {
    process.env.MYCELIUM_HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it("captures changed files, calls the LLM, and writes reports", async () => {
    const repoPath = path.join(tmpDir, "repo");
    await fse.ensureDir(repoPath);

    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["checkout", "-B", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "tester"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repoPath });

    await fse.outputFile(path.join(repoPath, "src", "app.ts"), "export const sum = (a, b) => a + b;");
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "init"], { cwd: repoPath });

    await execa("git", ["checkout", "-b", "agent/001-style-check"], { cwd: repoPath });
    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      [
        "export const sum = (first, second) => {",
        "  const total = first + second;",
        "  return total;",
        "};",
        "",
      ].join("\n"),
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "Refine naming"], { cwd: repoPath });

    const tasksRoot = path.join(repoPath, ".tasks");
    const taskDir = path.join(tasksRoot, "001-style-check");
    const manifestPath = path.join(taskDir, "manifest.json");
    const specPath = path.join(taskDir, "spec.md");
    await fse.ensureDir(taskDir);
    await fse.writeJson(manifestPath, {
      id: "001",
      name: "style-check",
      description: "Improve naming clarity",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: ["src/app.ts"] },
      affected_tests: [],
      verify: { doctor: "npm test" },
    });
    await fse.writeFile(specPath, "# 001 — Style check\n\nRefactor naming in app.ts.");

    const task: TaskSpec = {
      manifest: await fse.readJson(manifestPath),
      taskDirName: path.basename(taskDir),
      stage: "legacy",
      slug: "style-check",
    };

    const validatorConfig: ValidatorConfig = {
      enabled: true,
      mode: "warn",
      provider: "openai",
      model: "o3",
    };
    const llm = new FakeLlm({
      pass: true,
      summary: "Style looks consistent.",
      concerns: [],
      confidence: "high",
    });

    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-1" });
    const result = await runStyleValidator({
      projectName: "demo",
      repoPath,
      runId: "run-1",
      tasksRoot,
      task,
      taskSlug: task.slug,
      workspacePath: repoPath,
      mainBranch: "main",
      config: validatorConfig,
      orchestratorLog,
      llmClient: llm,
    });
    orchestratorLog.close();

    expect(result).not.toBeNull();
    expect(result?.pass).toBe(true);
    expect(result?.summary).toContain("Style");
    expect(llm.lastPrompt).toContain("src/app.ts");

    const reportPath = validatorReportPath(
      "demo",
      "run-1",
      "style-validator",
      task.manifest.id,
      task.slug,
    );
    const report = await fse.readJson(reportPath);
    expect(report.result.pass).toBe(true);
    expect(report.meta.changed_files).toContain("src/app.ts");

    const logPath = validatorLogPath("demo", "run-1", "style-validator");
    const logContent = await fse.readFile(logPath, "utf8");
    expect(logContent).toContain("validation.analysis");
  });
});
