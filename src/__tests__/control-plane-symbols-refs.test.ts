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
const FIXTURE_REPO = path.resolve(
  __dirname,
  "../../test/fixtures/control-plane-symbols-ts-repo",
);
const SYMBOL_REFS_TEST_TIMEOUT_MS = 15000;
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

function installExitOverride(command: Command): void {
  command.exitOverride();

  for (const child of command.commands) {
    installExitOverride(child);
  }
}

async function createTempRepoFromFixture(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-symbol-refs-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  return repoDir;
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cp-symbol-refs@example.com"], {
    cwd: repoDir,
  });
  await execa("git", ["config", "user.name", "Control Plane Symbol Refs"], {
    cwd: repoDir,
  });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function parseLastJsonLine<T>(logSpy: ReturnType<typeof vi.spyOn>): T {
  const line =
    logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).pop() ?? "";
  return JSON.parse(line) as T;
}



// =============================================================================
// TESTS
// =============================================================================

describe("control-plane symbol references", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it(
    "resolves TypeScript references for a symbol",
    async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cp",
      "symbols",
      "find",
      "UserId",
      "--json",
      "--repo",
      repoDir,
    ]);

    const findPayload = parseLastJsonLine<{
      ok: boolean;
      result?: { matches?: Array<{ symbol_id?: string }> };
    }>(logSpy);
    const symbolId = findPayload.result?.matches?.[0]?.symbol_id ?? "";

    await runCli([
      "node",
      "mycelium",
      "cp",
      "symbols",
      "refs",
      symbolId,
      "--json",
      "--repo",
      repoDir,
    ]);

    const refsPayload = parseLastJsonLine<{
      ok: boolean;
      result?: { references?: Array<{ file?: string; is_definition?: boolean }> };
    }>(logSpy);

    const references = refsPayload.result?.references ?? [];
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((ref) => ref.is_definition === false)).toBe(true);
    expect(references.every((ref) => ref.file === "src/index.ts")).toBe(true);
    },
    SYMBOL_REFS_TEST_TIMEOUT_MS,
  );

  it(
    "includes definition references when requested",
    async () => {
    const repoDir = await createTempRepoFromFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "mycelium",
      "cp",
      "symbols",
      "find",
      "UserId",
      "--json",
      "--repo",
      repoDir,
    ]);

    const findPayload = parseLastJsonLine<{
      ok: boolean;
      result?: { matches?: Array<{ symbol_id?: string }> };
    }>(logSpy);
    const symbolId = findPayload.result?.matches?.[0]?.symbol_id ?? "";

    await runCli([
      "node",
      "mycelium",
      "cp",
      "symbols",
      "refs",
      symbolId,
      "--include-definition",
      "--json",
      "--repo",
      repoDir,
    ]);

    const refsPayload = parseLastJsonLine<{
      ok: boolean;
      result?: { references?: Array<{ is_definition?: boolean }> };
    }>(logSpy);

    const references = refsPayload.result?.references ?? [];
    expect(references.some((ref) => ref.is_definition === true)).toBe(true);
    },
    SYMBOL_REFS_TEST_TIMEOUT_MS,
  );
});
