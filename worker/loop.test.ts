import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockCodexContext = {
  input: string;
  turn: number;
  workingDirectory: string;
};

type MockCodexHandler = (context: MockCodexContext) => Promise<void> | void;

let mockCodexHandler: MockCodexHandler | null = null;

function setMockCodexHandler(handler: MockCodexHandler | null): void {
  mockCodexHandler = handler;
}

vi.mock("./codex.js", () => {
  class MockRunner {
    threadId = "mock-thread";
    private turn = 0;
    private started = false;

    constructor(private readonly opts: { workingDirectory: string }) {}

    async streamPrompt(input: string, handlers: any): Promise<void> {
      this.turn += 1;
      if (!this.started) {
        this.started = true;
        await handlers.onThreadStarted?.(this.threadId);
      } else {
        await handlers.onThreadResumed?.(this.threadId);
      }

      if (mockCodexHandler) {
        await mockCodexHandler({
          input,
          turn: this.turn,
          workingDirectory: this.opts.workingDirectory,
        });
      }
    }
  }

  return {
    CodexRunner: MockRunner,
    createCodexRunner: (opts: { workingDirectory: string }) => new MockRunner(opts),
    __setMockCodexHandler: setMockCodexHandler,
  };
});

import { __setMockCodexHandler } from "./codex.js";
import { runWorker } from "./loop.js";
import { loadWorkerState, workerStatePath } from "./state.js";

describe("runWorker checkpoint commits", () => {
  let workspace: string;
  let manifestPath: string;
  let specPath: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "worker-loop-"));
    await execa("git", ["init"], { cwd: workspace });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: workspace });
    await execa("git", ["config", "user.name", "Tester"], { cwd: workspace });

    manifestPath = path.join(workspace, "manifest.json");
    specPath = path.join(workspace, "spec.md");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ id: "T1", name: "Checkpoint task" }, null, 2),
      "utf8",
    );
    await fs.writeFile(specPath, "# Spec\n\nDo things\n", "utf8");

    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "init"], { cwd: workspace });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    __setMockCodexHandler(null);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("creates a checkpoint commit when doctor fails", async () => {
    await fs.writeFile(path.join(workspace, "notes.txt"), "pending change\n", "utf8");

    const config = {
      taskId: "T1",
      taskSlug: "t1",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 1'",
      maxRetries: 1,
      bootstrapCmds: [],
      runLogsDir: path.join(workspace, "logs"),
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: true,
    };

    await expect(runWorker(config, { log: vi.fn() })).rejects.toThrow(/Max retries exceeded/);

    const headMessage = (
      await execa("git", ["log", "-1", "--pretty=%s"], { cwd: workspace })
    ).stdout.trim();
    expect(headMessage).toContain("WIP(Task T1): attempt 1 checkpoint");

    const headSha = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: workspace, stdio: "pipe" })
    ).stdout.trim();
    const state = await loadWorkerState(workspace);
    expect(state?.checkpoints).toEqual([
      {
        attempt: 1,
        sha: headSha,
        created_at: state?.checkpoints[0]?.created_at,
      },
    ]);
    expect(await fs.stat(workerStatePath(workspace))).toBeTruthy();
  });

  it("amends the checkpoint commit into a final commit when doctor passes", async () => {
    await fs.writeFile(path.join(workspace, "notes.txt"), "pending change\n", "utf8");

    const config = {
      taskId: "T1",
      taskSlug: "t1",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 0'",
      maxRetries: 1,
      bootstrapCmds: [],
      runLogsDir: path.join(workspace, "logs"),
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: true,
    };

    await runWorker(config, { log: vi.fn() });

    const headMessage = (
      await execa("git", ["log", "-1", "--pretty=%s"], { cwd: workspace })
    ).stdout.trim();
    expect(headMessage).toMatch(/^\[FEAT\] T1/);

    const headSha = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: workspace, stdio: "pipe" })
    ).stdout.trim();
    const state = await loadWorkerState(workspace);
    expect(state?.checkpoints).toEqual([
      {
        attempt: 1,
        sha: headSha,
        created_at: state?.checkpoints[0]?.created_at,
      },
    ]);
  });
});

describe("runWorker strict TDD", () => {
  let workspace: string;
  let manifestPath: string;
  let specPath: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "worker-loop-strict-"));
    await execa("git", ["init"], { cwd: workspace });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: workspace });
    await execa("git", ["config", "user.name", "Tester"], { cwd: workspace });

    manifestPath = path.join(workspace, "manifest.json");
    specPath = path.join(workspace, "spec.md");

    const manifest = {
      id: "TDD1",
      name: "Strict TDD task",
      verify: { doctor: "bash -c 'exit 1'", fast: "bash -c 'exit 1'" },
      tdd_mode: "strict",
      test_paths: ["tests/**"],
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(specPath, "# Spec\n\nDo TDD things\n", "utf8");

    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "init"], { cwd: workspace });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    __setMockCodexHandler(null);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("retries Stage A on non-test drift and cleans workspace", async () => {
    const readmePath = path.join(workspace, "README.md");
    await fs.writeFile(readmePath, "base\n", "utf8");
    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "add readme"], { cwd: workspace });

    const testFile = path.join(workspace, "tests", "alpha.test.ts");

    __setMockCodexHandler(async ({ turn, workingDirectory }) => {
      if (turn === 1) {
        await fs.writeFile(path.join(workingDirectory, "README.md"), "changed\n", "utf8");
      }
      if (turn === 1 || turn === 2) {
        await fs.mkdir(path.dirname(testFile), { recursive: true });
        await fs.writeFile(testFile, `test ${turn}\n`, "utf8");
      }
    });

    const runLogsDir = path.join(workspace, "logs");

    const config = {
      taskId: "TDD1",
      taskSlug: "tdd1",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 0'",
      maxRetries: 3,
      bootstrapCmds: [],
      runLogsDir,
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: false,
    };

    await runWorker(config, { log: vi.fn() });

    const readmeContents = await fs.readFile(readmePath, "utf8");
    expect(readmeContents).toBe("base\n");

    const attempt1SummaryRaw = await fs.readFile(
      path.join(runLogsDir, "attempt-001.summary.json"),
      "utf8",
    );
    const attempt1Summary = JSON.parse(attempt1SummaryRaw) as {
      retry?: { reason_code?: string };
      tdd?: { non_test_changes_detected?: string[] };
    };

    expect(attempt1Summary.retry?.reason_code).toBe("non_test_changes");
    expect(attempt1Summary.tdd?.non_test_changes_detected).toContain("README.md");
  });

  it("retries Stage A when verify.fast passes unexpectedly", async () => {
    const runLogsDir = path.join(workspace, "logs");
    await fs.mkdir(runLogsDir, { recursive: true });
    const sentinel = path.join(runLogsDir, ".fast-pass");
    const fastCmd = `bash -c 'if [ ! -f "${sentinel}" ]; then echo "fast ok"; touch "${sentinel}"; exit 0; fi; echo "fast fail"; exit 1'`;

    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    manifest.verify = { doctor: "bash -c 'exit 0'", fast: fastCmd };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "update fast command"], { cwd: workspace });

    const testFile = path.join(workspace, "tests", "beta.test.ts");
    __setMockCodexHandler(async ({ turn, workingDirectory }) => {
      if (turn === 1 || turn === 2) {
        await fs.mkdir(path.dirname(testFile), { recursive: true });
        await fs.writeFile(testFile, `test ${turn}\n`, "utf8");
      }
    });

    const config = {
      taskId: "TDD1",
      taskSlug: "tdd1",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 0'",
      maxRetries: 3,
      bootstrapCmds: [],
      runLogsDir,
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: false,
    };

    await runWorker(config, { log: vi.fn() });

    const attempt1SummaryRaw = await fs.readFile(
      path.join(runLogsDir, "attempt-001.summary.json"),
      "utf8",
    );
    const attempt2SummaryRaw = await fs.readFile(
      path.join(runLogsDir, "attempt-002.summary.json"),
      "utf8",
    );
    const attempt1Summary = JSON.parse(attempt1SummaryRaw) as {
      retry?: { reason_code?: string };
      tdd?: { fast_exit_code?: number };
    };
    const attempt2Summary = JSON.parse(attempt2SummaryRaw) as {
      retry?: { reason_code?: string };
      tdd?: { fast_exit_code?: number };
    };

    expect(attempt1Summary.retry?.reason_code).toBe("fast_passed");
    expect(attempt1Summary.tdd?.fast_exit_code).toBe(0);
    expect(attempt2Summary.retry?.reason_code).toBeUndefined();
    expect(attempt2Summary.tdd?.fast_exit_code).toBe(1);
  });
});

describe("runWorker lint step", () => {
  let workspace: string;
  let manifestPath: string;
  let specPath: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "worker-loop-lint-"));
    await execa("git", ["init"], { cwd: workspace });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: workspace });
    await execa("git", ["config", "user.name", "Tester"], { cwd: workspace });

    manifestPath = path.join(workspace, "manifest.json");
    specPath = path.join(workspace, "spec.md");

    const lintFlag = path.join(workspace, ".lint-ok");
    const lintCmd = `bash -c 'if [ ! -f "${lintFlag}" ]; then echo "lint failed"; touch "${lintFlag}"; exit 1; fi; echo "lint ok"'`;

    const manifest = {
      id: "LINT1",
      name: "Lint task",
      verify: { doctor: "bash -c 'exit 0'", lint: lintCmd },
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(specPath, "# Spec\n\nHandle lint\n", "utf8");

    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "init"], { cwd: workspace });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    __setMockCodexHandler(null);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("retries when lint fails before doctor", async () => {
    const doctorLog = path.join(workspace, "doctor.log");
    const runLogsDir = path.join(workspace, "logs");

    const config = {
      taskId: "LINT1",
      taskSlug: "lint1",
      manifestPath,
      specPath,
      doctorCmd: `bash -c 'echo doctor >> "${doctorLog}"'`,
      maxRetries: 2,
      bootstrapCmds: [],
      runLogsDir,
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: false,
    };

    await runWorker(config, { log: vi.fn() });

    const lintAttempt1 = await fs.readFile(
      path.join(runLogsDir, "lint-attempt-001.log"),
      "utf8",
    );
    const lintAttempt2 = await fs.readFile(
      path.join(runLogsDir, "lint-attempt-002.log"),
      "utf8",
    );

    expect(lintAttempt1).toContain("lint failed");
    expect(lintAttempt2).toContain("lint ok");

    const doctorRuns = (await fs.readFile(doctorLog, "utf8")).trim().split("\n").filter(Boolean);
    expect(doctorRuns).toHaveLength(1);
  });
});

describe("runWorker max retries", () => {
  let workspace: string;
  let manifestPath: string;
  let specPath: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "worker-loop-retries-"));
    await execa("git", ["init"], { cwd: workspace });
    await execa("git", ["config", "user.email", "tester@example.com"], { cwd: workspace });
    await execa("git", ["config", "user.name", "Tester"], { cwd: workspace });

    manifestPath = path.join(workspace, "manifest.json");
    specPath = path.join(workspace, "spec.md");

    const manifest = {
      id: "RETRY0",
      name: "Unlimited retries task",
      verify: { doctor: "bash -c 'exit 0'" },
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(specPath, "# Spec\n\nRetry forever\n", "utf8");

    await execa("git", ["add", "-A"], { cwd: workspace });
    await execa("git", ["commit", "-m", "init"], { cwd: workspace });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    __setMockCodexHandler(null);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("accepts maxRetries=0 as unlimited", async () => {
    const runLogsDir = path.join(workspace, "logs");
    const config = {
      taskId: "RETRY0",
      taskSlug: "retry0",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 0'",
      maxRetries: 0,
      bootstrapCmds: [],
      runLogsDir,
      codexHome: path.join(workspace, ".mycelium", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: false,
    };

    await runWorker(config, { log: vi.fn() });

    await expect(
      fs.readFile(path.join(runLogsDir, "attempt-001.summary.json"), "utf8"),
    ).resolves.toBeTruthy();
  });
});
