import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";

const HELP_ERROR_CODE = "commander.helpDisplayed";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const tempDirs: string[] = [];

// =============================================================================
// HELPERS
// =============================================================================

async function runCli(argv: string[], options: { allowHelp?: boolean } = {}): Promise<void> {
  const program = buildCli();
  installExitOverride(program);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (options.allowHelp && isHelpExit(error)) {
      return;
    }
    throw error;
  }
}

function isHelpExit(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: string }).code === HELP_ERROR_CODE;
}

function collectStdout(writeSpy: ReturnType<typeof vi.spyOn>): string {
  return writeSpy.mock.calls
    .map(([chunk]: [string | Uint8Array]) =>
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    )
    .join("");
}

function collectStderr(writeSpy: ReturnType<typeof vi.spyOn>): string {
  return writeSpy.mock.calls
    .map(([chunk]: [string | Uint8Array]) =>
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    )
    .join("");
}

function installExitOverride(command: Command): void {
  command.exitOverride();

  for (const child of command.commands) {
    installExitOverride(child);
  }
}

async function createTempRepoFromFixture(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-cli-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  return repoDir;
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cp-cli@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Control Plane CLI"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
}

async function writePolicyEvalManifest(repoDir: string): Promise<string> {
  const taskDir = path.join(repoDir, ".mycelium", "tasks", "099-policy-eval");
  await fs.mkdir(taskDir, { recursive: true });

  const manifest = {
    id: "099",
    name: "Policy eval CLI test",
    description: "Fixture manifest for policy eval CLI output.",
    estimated_minutes: 10,
    dependencies: [],
    locks: { reads: [], writes: [] },
    files: { reads: [], writes: ["apps/web/src/index.ts"] },
    affected_tests: [],
    test_paths: [],
    tdd_mode: "off",
    verify: { doctor: "npm test" },
  };

  const manifestPath = path.join(taskDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifestPath;
}

async function commitPolicyEvalChange(repoDir: string): Promise<void> {
  const targetPath = path.join(repoDir, "apps", "web", "src", "index.ts");
  await fs.appendFile(targetPath, "\n// policy eval change\n", "utf8");
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "policy eval change"], { cwd: repoDir });
}

// =============================================================================
// TESTS
// =============================================================================

describe("control graph CLI", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("renders help for the cg alias", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "mycelium", "cg", "--help"], { allowHelp: true });

    const output = collectStdout(writeSpy);
    expect(output).toContain("control-graph");
  });

  it("warns when using the deprecated cp alias", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "mycelium", "cp", "--help"], { allowHelp: true });

    const output = collectStderr(writeSpy);
    expect(output).toContain("deprecated");
    expect(output).toContain("mycelium cg");
  });

  it("runs cg search with max and glob filters", async () => {
    const repoDir = await createTempRepoFromFixture();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli([
      "node",
      "mycelium",
      "cg",
      "search",
      "UserTracker",
      "--repo",
      repoDir,
      "--glob",
      "apps/web/src/**",
      "--max",
      "1",
    ]);

    const output = collectStdout(writeSpy);
    const lines = output.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("apps/web/src/index.ts");
  });

  it("returns a JSON error when --no-build is set", async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cg",
      "components",
      "list",
      "--json",
      "--no-build",
      "--repo",
      repoDir,
    ]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as {
      ok: boolean;
      error?: { code?: string; message?: string; hint?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("MODEL_NOT_BUILT");
    expect(payload.error?.message).toBe("Control plane model not built.");
    expect(payload.error?.hint).toBe("Run `mycelium cp build` to generate it.");
    expect(process.exitCode).toBe(1);
  });

  it("auto-builds the model for components list queries", async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["node", "mycelium", "cg", "components", "list", "--json", "--repo", repoDir]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as { ok: boolean; result?: unknown };

    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.result)).toBe(true);
    const result = payload.result as Array<{ id?: string }>;
    expect(result.length).toBeGreaterThan(0);
    expect(result.map((component) => component.id)).toContain("acme-web-app");
  });

  it("auto-builds the model for owner lookups", async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cg",
      "owner",
      "apps/web/src/index.ts",
      "--json",
      "--repo",
      repoDir,
    ]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as {
      ok: boolean;
      result?: { owner?: { component?: { id?: string } } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.result?.owner?.component?.id).toBe("acme-web-app");
  });

  it("evaluates policy decisions with JSON output", async () => {
    const repoDir = await createTempRepoFromFixture();
    const manifestPath = await writePolicyEvalManifest(repoDir);
    await commitPolicyEvalChange(repoDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cg",
      "policy",
      "eval",
      "--json",
      "--repo",
      repoDir,
      "--base-sha",
      "HEAD~1",
      "--diff",
      "HEAD~1..HEAD",
      "--manifest",
      manifestPath,
    ]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as {
      ok: boolean;
      result?: {
        base_sha?: string;
        diff?: string | null;
        lock_derivation?: { derived_write_resources?: string[] };
        blast_radius?: { changed_files?: string[]; touched_components?: string[] };
        surface_detection?: { is_surface_change?: boolean; categories?: string[] };
        tier?: number;
        required_checks?: { selected_command?: string };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.result?.base_sha).toEqual(expect.any(String));
    expect(payload.result?.diff).toBe("HEAD~1..HEAD");
    expect(payload.result?.lock_derivation?.derived_write_resources).toContain(
      "component:acme-web-app",
    );
    expect(payload.result?.blast_radius?.changed_files).toContain("apps/web/src/index.ts");
    expect(payload.result?.blast_radius?.touched_components).toContain("acme-web-app");
    expect(payload.result?.surface_detection?.is_surface_change).toBe(true);
    expect(payload.result?.surface_detection?.categories).toContain("public-entrypoint");
    expect(payload.result?.tier).toEqual(expect.any(Number));
    expect(payload.result?.required_checks?.selected_command).toBe("npm test");
  });
});
