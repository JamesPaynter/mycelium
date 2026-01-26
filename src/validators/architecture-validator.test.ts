import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArchitectureValidatorConfig } from "../core/config.js";
import { JsonlLogger } from "../core/logger.js";
import { validatorLogPath, validatorReportPath } from "../core/paths.js";
import type { TaskSpec } from "../core/task-manifest.js";
import type { LlmClient, LlmCompletionResult } from "../llm/client.js";
import { runArchitectureValidator } from "./architecture-validator.js";

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

describe("runArchitectureValidator", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "architecture-validator-"));
    originalHome = process.env.MYCELIUM_HOME;
    process.env.MYCELIUM_HOME = path.join(tmpDir, ".mycelium");
  });

  afterEach(async () => {
    process.env.MYCELIUM_HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it("discovers architecture docs and includes them in the prompt", async () => {
    const repoPath = path.join(tmpDir, "repo");
    await fse.ensureDir(repoPath);

    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["checkout", "-B", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "tester"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repoPath });

    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      "export const sum = (a, b) => a + b;",
    );
    await fse.outputFile(
      path.join(repoPath, "docs", "architecture.md"),
      "# Architecture\n\n- Keep math logic in src/app.ts\n",
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "init"], { cwd: repoPath });

    await execa("git", ["checkout", "-b", "agent/001-arch-review"], { cwd: repoPath });
    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      ["export const sum = (first, second) => {", "  return first + second;", "};", ""].join("\n"),
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "Refactor sum"], { cwd: repoPath });

    const tasksRoot = path.join(repoPath, ".tasks");
    const taskDir = path.join(tasksRoot, "001-arch-review");
    const manifestPath = path.join(taskDir, "manifest.json");
    const specPath = path.join(taskDir, "spec.md");
    await fse.ensureDir(taskDir);
    await fse.writeJson(manifestPath, {
      id: "001",
      name: "arch-review",
      description: "Refactor sum implementation",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: ["src/app.ts"] },
      affected_tests: [],
      verify: { doctor: "npm test" },
    });
    await fse.writeFile(specPath, "# 001 — Architecture review\n\nRefactor sum().");

    const task: TaskSpec = {
      manifest: await fse.readJson(manifestPath),
      taskDirName: path.basename(taskDir),
      stage: "legacy",
      slug: "arch-review",
    };

    const validatorConfig: ArchitectureValidatorConfig = {
      enabled: true,
      mode: "warn",
      provider: "openai",
      model: "o3",
      docs_glob: "docs/architecture*.md",
      fail_if_docs_missing: false,
    };
    const llm = new FakeLlm({
      pass: true,
      summary: "Architecture aligns.",
      concerns: [],
      recommendations: [],
      confidence: "high",
    });

    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-1" });
    const result = await runArchitectureValidator({
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
    expect(result?.summary).toContain("Architecture");
    expect(llm.lastPrompt).toContain("docs/architecture.md");
    expect(llm.lastPrompt).toContain("Keep math logic in src/app.ts");

    const reportPath = validatorReportPath(
      "demo",
      "run-1",
      "architecture-validator",
      task.manifest.id,
      task.slug,
    );
    const report = await fse.readJson(reportPath);
    expect(report.result.pass).toBe(true);
    expect(report.meta.docs).toContain("docs/architecture.md");

    const logPath = validatorLogPath("demo", "run-1", "architecture-validator");
    const logContent = await fse.readFile(logPath, "utf8");
    expect(logContent).toContain("validation.analysis");
  });

  it("skips when docs are missing and fail_if_docs_missing is false", async () => {
    const repoPath = path.join(tmpDir, "repo");
    await fse.ensureDir(repoPath);

    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["checkout", "-B", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "tester"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repoPath });

    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      "export const sum = (a, b) => a + b;",
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "init"], { cwd: repoPath });

    await execa("git", ["checkout", "-b", "agent/002-arch-skip"], { cwd: repoPath });
    await fse.outputFile(
      path.join(repoPath, "src", "app.ts"),
      ["export const sum = (first, second) => {", "  return first + second;", "};", ""].join("\n"),
    );
    await execa("git", ["add", "."], { cwd: repoPath });
    await execa("git", ["commit", "-m", "Refactor sum"], { cwd: repoPath });

    const tasksRoot = path.join(repoPath, ".tasks");
    const taskDir = path.join(tasksRoot, "002-arch-skip");
    const manifestPath = path.join(taskDir, "manifest.json");
    const specPath = path.join(taskDir, "spec.md");
    await fse.ensureDir(taskDir);
    await fse.writeJson(manifestPath, {
      id: "002",
      name: "arch-skip",
      description: "Refactor sum implementation",
      estimated_minutes: 5,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: ["src/app.ts"] },
      affected_tests: [],
      verify: { doctor: "npm test" },
    });
    await fse.writeFile(specPath, "# 002 — Architecture skip\n\nRefactor sum().");

    const task: TaskSpec = {
      manifest: await fse.readJson(manifestPath),
      taskDirName: path.basename(taskDir),
      stage: "legacy",
      slug: "arch-skip",
    };

    const validatorConfig: ArchitectureValidatorConfig = {
      enabled: true,
      mode: "warn",
      provider: "openai",
      model: "o3",
      docs_glob: "docs/architecture*.md",
      fail_if_docs_missing: false,
    };
    const llm = new FakeLlm({
      pass: false,
      summary: "Should not be called",
      concerns: [],
      recommendations: [],
      confidence: "high",
    });

    const orchestratorLog = new JsonlLogger(path.join(tmpDir, "orch.jsonl"), { runId: "run-2" });
    const result = await runArchitectureValidator({
      projectName: "demo",
      repoPath,
      runId: "run-2",
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
    expect(result?.summary).toContain("No architecture docs");
    expect(llm.lastPrompt).toBe("");

    const reportPath = validatorReportPath(
      "demo",
      "run-2",
      "architecture-validator",
      task.manifest.id,
      task.slug,
    );
    const report = await fse.readJson(reportPath);
    expect(report.result.pass).toBe(true);
    expect(report.meta.docs).toHaveLength(0);
  });
});
