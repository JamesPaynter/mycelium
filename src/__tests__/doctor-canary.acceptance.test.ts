import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { runProject } from "../core/executor.js";
import { orchestratorLogPath } from "../core/paths.js";

const ENV_VARS = ["MYCELIUM_HOME", "MOCK_LLM"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;
const TEST_TIMEOUT_MS = 20_000;

describe("acceptance: doctor canary config + logging", () => {
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

  it(
    "skips canary when disabled",
    async () => {
      const { repoDir, homeDir } = await makeRepoWithSingleTask(tempRoots);
      process.env.MYCELIUM_HOME = homeDir;
      process.env.MOCK_LLM = "1";

      const config = makeConfig(repoDir, {
        doctorCommand: 'node -e "process.exit(0)"',
        doctorCanary: {
          mode: "off",
          env_var: "ORCH_CANARY",
          warn_on_unexpected_pass: true,
        },
      });

      const result = await runProject("doctor-canary-disabled", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      const events = await readLogEvents(
        orchestratorLogPath("doctor-canary-disabled", result.runId),
      );
      const skipped = events.find((event) => event.type === "doctor.canary.skipped");

      expect((skipped?.payload as { reason?: string } | undefined)?.reason).toBe(
        "disabled_by_config",
      );
      expect(events.some((event) => event.type === "doctor.canary.start")).toBe(false);
      expect(events.some((event) => event.type === "doctor.canary.unexpected_pass")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "logs unexpected pass as a warning with the configured env var",
    async () => {
      const { repoDir, homeDir } = await makeRepoWithSingleTask(tempRoots);
      process.env.MYCELIUM_HOME = homeDir;
      process.env.MOCK_LLM = "1";

      const config = makeConfig(repoDir, {
        doctorCommand: 'node -e "process.exit(0)"',
        doctorCanary: {
          mode: "env",
          env_var: "MYCELIUM_CANARY",
          warn_on_unexpected_pass: true,
        },
      });

      const result = await runProject("doctor-canary-unexpected", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      const events = await readLogEvents(
        orchestratorLogPath("doctor-canary-unexpected", result.runId),
      );
      const unexpected = events.find((event) => event.type === "doctor.canary.unexpected_pass");

      const unexpectedPayload = unexpected?.payload as
        | { env_var?: string; severity?: string }
        | undefined;
      expect(unexpectedPayload?.env_var).toBe("MYCELIUM_CANARY");
      expect(unexpectedPayload?.severity).toBe("warn");
      expect(events.some((event) => event.type === "doctor.canary.expected_fail")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "logs expected fail when the canary env var forces failure",
    async () => {
      const { repoDir, homeDir } = await makeRepoWithSingleTask(tempRoots);
      process.env.MYCELIUM_HOME = homeDir;
      process.env.MOCK_LLM = "1";

      const config = makeConfig(repoDir, {
        doctorCommand: "node -e \"process.exit(process.env.MYCELIUM_CANARY === '1' ? 1 : 0)\"",
        doctorCanary: {
          mode: "env",
          env_var: "MYCELIUM_CANARY",
          warn_on_unexpected_pass: true,
        },
      });

      const result = await runProject("doctor-canary-expected", config, {
        maxParallel: 1,
        useDocker: false,
        buildImage: false,
      });

      const events = await readLogEvents(
        orchestratorLogPath("doctor-canary-expected", result.runId),
      );
      const expectedFail = events.find((event) => event.type === "doctor.canary.expected_fail");

      const expectedPayload = expectedFail?.payload as
        | { env_var?: string; exit_code?: number }
        | undefined;
      expect(expectedPayload?.env_var).toBe("MYCELIUM_CANARY");
      expect(expectedPayload?.exit_code).toBe(1);
      expect(events.some((event) => event.type === "doctor.canary.unexpected_pass")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

async function makeRepoWithSingleTask(
  tempRoots: string[],
): Promise<{ repoDir: string; homeDir: string }> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-canary-"));
  tempRoots.push(tmpRoot);

  const repoDir = path.join(tmpRoot, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "canary@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Canary Tester"], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, "README.md"), "# Repo\n", "utf8");
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });

  const taskDir = path.join(repoDir, ".mycelium", "tasks", "001-canary");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, "manifest.json"),
    JSON.stringify(
      {
        id: "001",
        name: "Canary",
        description: "Ensure doctor canary logging is correct.",
        estimated_minutes: 1,
        dependencies: [],
        locks: { reads: [], writes: ["repo"] },
        files: { reads: [], writes: ["notes/doctor-canary.txt"] },
        affected_tests: [],
        test_paths: [],
        tdd_mode: "off",
        verify: { doctor: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(taskDir, "spec.md"), "# Spec\n", "utf8");

  return { repoDir, homeDir: path.join(tmpRoot, ".mycelium-home") };
}

function makeConfig(
  repoDir: string,
  overrides: {
    doctorCommand: string;
    doctorCanary: { mode: "off" | "env"; env_var: string; warn_on_unexpected_pass: boolean };
  },
): any {
  return {
    repo_path: repoDir,
    main_branch: "main",
    task_branch_prefix: "agent/",
    tasks_dir: ".mycelium/tasks",
    planning_dir: ".mycelium/planning",
    max_parallel: 1,
    max_retries: 1,
    doctor: overrides.doctorCommand,
    doctor_timeout: 30,
    doctor_canary: overrides.doctorCanary,
    bootstrap: [],
    test_paths: ["**/*"],
    resources: [{ name: "repo", paths: ["**/*"] }],
    docker: {
      image: "mycelium-worker:latest",
      dockerfile: "templates/Dockerfile",
      build_context: ".",
      user: "worker",
      network_mode: "bridge",
    },
    manifest_enforcement: "warn",
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock", checkpoint_commits: true },
    budgets: { mode: "warn" },
  };
}

async function readLogEvents(logFile: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(logFile, "utf8");
  const events: Array<Record<string, unknown>> = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      events.push(parsed);
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return events;
}
