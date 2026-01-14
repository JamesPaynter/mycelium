import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./codex.js", () => ({
  CodexRunner: class {
    threadId = "mock-thread";

    async streamPrompt(_input: string, handlers: any): Promise<void> {
      await handlers.onThreadStarted?.(this.threadId);
    }
  },
}));

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
      codexHome: path.join(workspace, ".task-orchestrator", "codex-home"),
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
      codexHome: path.join(workspace, ".task-orchestrator", "codex-home"),
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
      verify: { doctor: "bash -c 'exit 1'", fast: "bash -c 'exit 0'" },
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
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("fails Stage A when verify.fast unexpectedly passes", async () => {
    const config = {
      taskId: "TDD1",
      taskSlug: "tdd1",
      manifestPath,
      specPath,
      doctorCmd: "bash -c 'exit 1'",
      maxRetries: 1,
      bootstrapCmds: [],
      runLogsDir: path.join(workspace, "logs"),
      codexHome: path.join(workspace, ".task-orchestrator", "codex-home"),
      workingDirectory: workspace,
      checkpointCommits: false,
    };

    await expect(runWorker(config, { log: vi.fn() })).rejects.toThrow(/verify\.fast/);
  });
});
