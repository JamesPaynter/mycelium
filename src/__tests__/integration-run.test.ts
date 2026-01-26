import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { planProject } from "../cli/plan.js";
import { loadProjectConfig } from "../core/config-loader.js";
import { runProject } from "../core/executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/toy-repo");

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM", "MOCK_LLM_OUTPUT_PATH"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("integration: plan + run (mock LLM)", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const dir of tempRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempRoots.length = 0;

    for (const key of ENV_VARS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("plans tasks and merges the integration branch with mock workers", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "to-int-"));
    tempRoots.push(tmpRoot);

    const repoDir = path.join(tmpRoot, "repo");
    await fse.copy(FIXTURE_REPO, repoDir);
    await initGitRepo(repoDir);

    const configPath = path.join(tmpRoot, "project.yaml");
    await writeProjectConfig(configPath, repoDir);

    process.env.MYCELIUM_HOME = path.join(tmpRoot, ".mycelium");
    process.env.MOCK_LLM = "1";
    process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");

    const config = loadProjectConfig(configPath);
    const headBefore = await gitHead(repoDir, config.main_branch);

    const planResult = await planProject("toy-project", config, {
      input: "docs/planning/implementation-plan.md",
    });
    expect(planResult.tasks).toHaveLength(2);

    const runResult = await runProject("toy-project", config, {
      maxParallel: 2,
      useDocker: false,
      buildImage: false,
    });

    const headAfter = await gitHead(repoDir, config.main_branch);
    const runSummaryPath = path.join(
      repoDir,
      ".mycelium",
      "reports",
      "control-plane",
      "run-summary",
      `${runResult.runId}.json`,
    );
    const runSummary = await fse.readJson(runSummaryPath);

    const writtenFiles = await Promise.all([
      fs.readFile(path.join(repoDir, "notes/release-notes.txt"), "utf8"),
      fs.readFile(path.join(repoDir, "src/feature.txt"), "utf8"),
    ]);

    expect(runResult.state.status).toBe("complete");
    expect(headAfter).not.toBe(headBefore);
    expect(runResult.plan[0]?.taskIds.sort()).toEqual(["001", "002"]);
    expect(runResult.state.batches.every((b) => b.integration_doctor_passed === true)).toBe(true);
    expect(writtenFiles[0]).toContain("Mock update");
    expect(writtenFiles[1]).toContain("Mock update");
    expect(runSummary).toMatchObject({
      run_id: runResult.runId,
      project: "toy-project",
      status: "complete",
      metrics: {
        scope_violations: { warn_count: 0, block_count: 0 },
        fallback_repo_root_count: 0,
        avg_impacted_components: 0,
        derived_lock_mode_enabled: false,
      },
    });
    expect(runSummary.metrics.avg_batch_size).toBe(2);
    expect(runSummary.metrics.doctor_seconds_total).toBeTypeOf("number");
    expect(runSummary.metrics.checkset_seconds_total).toBeTypeOf("number");
  }, 30_000);

  it("loads tasks from legacy layout when plan output targets root", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "to-int-legacy-"));
    tempRoots.push(tmpRoot);

    const repoDir = path.join(tmpRoot, "repo");
    await fse.copy(FIXTURE_REPO, repoDir);
    await initGitRepo(repoDir);

    const configPath = path.join(tmpRoot, "project.yaml");
    await writeProjectConfig(configPath, repoDir);

    process.env.MYCELIUM_HOME = path.join(tmpRoot, ".mycelium");
    process.env.MOCK_LLM = "1";
    process.env.MOCK_LLM_OUTPUT_PATH = path.join(repoDir, "mock-planner-output.json");

    const config = loadProjectConfig(configPath);

    const planResult = await planProject("toy-project", config, {
      input: "docs/planning/implementation-plan.md",
      output: ".tasks",
    });
    expect(planResult.outputDir).toBe(path.join(repoDir, ".tasks"));
    expect(await fse.pathExists(path.join(repoDir, ".tasks", "backlog"))).toBe(false);

    const runResult = await runProject("toy-project", config, {
      maxParallel: 2,
      useDocker: false,
      buildImage: false,
    });

    expect(runResult.state.status).toBe("complete");
    expect(runResult.plan[0]?.taskIds.sort()).toEqual(["001", "002"]);
  }, 20_000);
});

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "integration@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Integration Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

async function writeProjectConfig(configPath: string, repoDir: string): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .tasks",
    "doctor: npm test",
    "max_parallel: 2",
    "resources:",
    "  - name: docs",
    '    paths: ["notes/**"]',
    "  - name: code",
    '    paths: ["src/**"]',
    "planner:",
    "  provider: mock",
    "  model: mock",
    "worker:",
    "  model: mock",
    "  checkpoint_commits: true",
    "docker:",
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

async function gitHead(repoDir: string, branch: string): Promise<string> {
  const res = await execa("git", ["rev-parse", branch], { cwd: repoDir });
  return res.stdout.trim();
}
