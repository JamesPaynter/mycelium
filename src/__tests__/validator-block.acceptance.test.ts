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

const ENV_VARS = [
  "MYCELIUM_HOME",
  "MOCK_LLM",
  "MOCK_LLM_OUTPUT_PATH",
  "MOCK_LLM_OUTPUT",
  "MOCK_CODEX_USAGE",
] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

describe("acceptance: validator mode=block prevents merge and flags human review", () => {
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

  it("blocks merge when test validator fails (mode=block)", { timeout: 60_000 }, async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-validator-"));
    tempRoots.push(tmpRoot);

    const repoDir = path.join(tmpRoot, "repo");
    await fse.copy(FIXTURE_REPO, repoDir);
    await initGitRepo(repoDir);

    const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
    await fs.writeFile(plannerOutputPath, JSON.stringify(mockPlannerOutput(), null, 2));

    const configPath = path.join(tmpRoot, "project.yaml");
    await writeProjectConfig(configPath, repoDir, [
      "test_validator:",
      "  mode: block",
      "  provider: mock",
      "  model: mock",
    ]);

    process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
    process.env.MOCK_LLM = "1";
    // Phase 1: planning (planner consumes MOCK_LLM_OUTPUT_PATH).
    process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
    delete process.env.MOCK_LLM_OUTPUT;
    delete process.env.MOCK_CODEX_USAGE;

    const config = loadProjectConfig(configPath);
    const headBefore = await gitHead(repoDir, config.main_branch);

    const planResult = await planProject("toy-project", config, {
      input: "docs/planning/implementation-plan.md",
    });
    expect(planResult.tasks).toHaveLength(1);

    // Phase 2: execution + validator (validator consumes MOCK_LLM_OUTPUT).
    delete process.env.MOCK_LLM_OUTPUT_PATH;
    process.env.MOCK_LLM_OUTPUT = JSON.stringify({
      pass: false,
      summary: "Intentionally failing validator for acceptance test",
      concerns: [],
      coverage_gaps: [],
      confidence: "high",
    });

    const runResult = await runProject("toy-project", config, {
      maxParallel: 1,
      useDocker: false,
      buildImage: false,
    });

    const headAfter = await gitHead(repoDir, config.main_branch);

    expect(runResult.state.status).toBe("paused");
    expect(runResult.state.tasks["001"]?.status).toBe("needs_human_review");
    expect(headAfter).toBe(headBefore);
  });

  it(
    "blocks merge when architecture validator fails (mode=block)",
    { timeout: 60_000 },
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-arch-validator-"));
      tempRoots.push(tmpRoot);

      const repoDir = path.join(tmpRoot, "repo");
      await fse.copy(FIXTURE_REPO, repoDir);
      await fs.mkdir(path.join(repoDir, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "docs", "architecture.md"),
        "# Architecture\n\n- Keep validation logic in validators/.\n",
      );
      await initGitRepo(repoDir);

      const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
      await fs.writeFile(plannerOutputPath, JSON.stringify(mockPlannerOutput(), null, 2));

      const configPath = path.join(tmpRoot, "project.yaml");
      await writeProjectConfig(configPath, repoDir, [
        "architecture_validator:",
        "  mode: block",
        "  provider: mock",
        "  model: mock",
        '  docs_glob: "docs/architecture*.md"',
        "  fail_if_docs_missing: true",
      ]);

      process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
      process.env.MOCK_LLM = "1";
      process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
      delete process.env.MOCK_LLM_OUTPUT;
      delete process.env.MOCK_CODEX_USAGE;

      const config = loadProjectConfig(configPath);
      const headBefore = await gitHead(repoDir, config.main_branch);

      const planResult = await planProject("toy-project", config, {
        input: "docs/planning/implementation-plan.md",
      });
      expect(planResult.tasks).toHaveLength(1);

      delete process.env.MOCK_LLM_OUTPUT_PATH;
      process.env.MOCK_LLM_OUTPUT = JSON.stringify({
        pass: false,
        summary: "Architecture validator failure for acceptance test",
        concerns: [],
        recommendations: [],
        confidence: "high",
      });

      const runResult = await runProject("toy-project", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      const headAfter = await gitHead(repoDir, config.main_branch);

      expect(runResult.state.status).toBe("paused");
      expect(runResult.state.tasks["001"]?.status).toBe("needs_human_review");
      expect(headAfter).toBe(headBefore);
    },
  );

  it("respects style validator warn vs block modes", { timeout: 90_000 }, async () => {
    await runStyleValidatorScenario({
      mode: "warn",
      expectBlocked: false,
      tempRoots,
    });

    await runStyleValidatorScenario({
      mode: "block",
      expectBlocked: true,
      tempRoots,
    });
  });
});

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "integration@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Integration Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

async function writeProjectConfig(
  configPath: string,
  repoDir: string,
  validatorLines: string[],
): Promise<void> {
  const dockerfile = path.join(process.cwd(), "templates/Dockerfile");
  const buildContext = process.cwd();
  const configContents = [
    `repo_path: ${repoDir}`,
    "main_branch: main",
    "tasks_dir: .mycelium/tasks",
    "planning_dir: .mycelium/planning",
    "doctor: 'node -e \"process.exit(0)\"'",
    "max_parallel: 1",
    "resources:",
    "  - name: repo",
    '    paths: ["**/*"]',
    "planner:",
    "  provider: mock",
    "  model: mock",
    "worker:",
    "  model: mock",
    "  checkpoint_commits: true",
    ...validatorLines,
    "docker:",
    `  dockerfile: ${dockerfile}`,
    `  build_context: ${buildContext}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, configContents, "utf8");
}

function mockPlannerOutput(): unknown {
  return {
    tasks: [
      {
        id: "001",
        name: "validator-demo",
        description: "Triggers validator blocking to ensure Mycelium does not merge.",
        estimated_minutes: 5,
        dependencies: [],
        locks: { reads: [], writes: ["repo"] },
        files: { reads: [], writes: ["tests/validator-demo.test.ts"] },
        affected_tests: [],
        test_paths: [],
        tdd_mode: "off",
        verify: { doctor: 'node -e "process.exit(0)"' },
        spec: "Write a small file change; validator will block merge.",
      },
    ],
  };
}

async function gitHead(repoDir: string, branch: string): Promise<string> {
  const res = await execa("git", ["rev-parse", branch], { cwd: repoDir });
  return res.stdout.trim();
}

async function runStyleValidatorScenario(args: {
  mode: "warn" | "block";
  expectBlocked: boolean;
  tempRoots: string[];
}): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-style-validator-"));
  args.tempRoots.push(tmpRoot);

  const repoDir = path.join(tmpRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  const plannerOutputPath = path.join(tmpRoot, "mock-planner-output.json");
  await fs.writeFile(plannerOutputPath, JSON.stringify(mockPlannerOutput(), null, 2));

  const configPath = path.join(tmpRoot, "project.yaml");
  await writeProjectConfig(configPath, repoDir, [
    "style_validator:",
    `  mode: ${args.mode}`,
    "  provider: mock",
    "  model: mock",
  ]);

  process.env.MYCELIUM_HOME = path.join(tmpRoot, "mycelium-home");
  process.env.MOCK_LLM = "1";
  process.env.MOCK_LLM_OUTPUT_PATH = plannerOutputPath;
  delete process.env.MOCK_LLM_OUTPUT;
  delete process.env.MOCK_CODEX_USAGE;

  const config = loadProjectConfig(configPath);
  const headBefore = await gitHead(repoDir, config.main_branch);

  const planResult = await planProject("toy-project", config, {
    input: "docs/planning/implementation-plan.md",
  });
  expect(planResult.tasks).toHaveLength(1);

  delete process.env.MOCK_LLM_OUTPUT_PATH;
  process.env.MOCK_LLM_OUTPUT = JSON.stringify({
    pass: false,
    summary: "Intentionally failing style validator for acceptance test",
    concerns: [],
    confidence: "high",
  });

  const runResult = await runProject("toy-project", config, {
    maxParallel: 1,
    useDocker: false,
    buildImage: false,
  });

  const headAfter = await gitHead(repoDir, config.main_branch);

  if (args.expectBlocked) {
    expect(runResult.state.status).toBe("paused");
    expect(runResult.state.tasks["001"]?.status).toBe("needs_human_review");
    expect(headAfter).toBe(headBefore);
  } else {
    expect(runResult.state.status).toBe("complete");
    expect(runResult.state.tasks["001"]?.status).toBe("complete");
    expect(headAfter).not.toBe(headBefore);
  }
}
