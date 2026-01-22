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



// =============================================================================
// TESTS
// =============================================================================

describe("control-plane CLI", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("renders help for the cp alias", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "mycelium", "cp", "--help"], { allowHelp: true });

    const output = collectStdout(writeSpy);
    expect(output).toContain("control-plane");
  });

  it("returns a JSON error when --no-build is set", async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cp",
      "components",
      "list",
      "--json",
      "--no-build",
      "--repo",
      repoDir,
    ]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as { ok: boolean; error?: { code?: string; message?: string } };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("MODEL_NOT_BUILT");
    expect(payload.error?.message).toEqual(expect.any(String));
    expect(process.exitCode).toBe(1);
  });

  it("auto-builds the model for components list queries", async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["node", "mycelium", "cp", "components", "list", "--json", "--repo", repoDir]);

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
      "cp",
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
});
