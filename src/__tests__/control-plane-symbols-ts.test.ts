import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";
import { extractComponents } from "../control-plane/extract/components.js";
import { buildOwnershipIndex } from "../control-plane/extract/ownership.js";
import { extractTypeScriptSymbolDefinitions } from "../control-plane/extract/symbols-ts/index.js";

const HELP_ERROR_CODE = "commander.helpDisplayed";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-symbols-ts-repo");
const SYMBOLS_TS_TEST_TIMEOUT_MS = 30000;
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-symbols-"));
  tempDirs.push(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  await fse.copy(FIXTURE_REPO, repoDir);
  await initGitRepo(repoDir);

  return repoDir;
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "cp-symbols@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Control Plane Symbols"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function findByName(definitions: { name: string }[], name: string): number {
  return definitions.findIndex((definition) => definition.name === name);
}

// =============================================================================
// TESTS
// =============================================================================

describe("control-plane TypeScript symbols", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it(
    "extracts symbol definitions from TypeScript sources",
    async () => {
      const { components } = await extractComponents(FIXTURE_REPO);
      const ownership = buildOwnershipIndex(components);

      const result = await extractTypeScriptSymbolDefinitions({
        repoRoot: FIXTURE_REPO,
        components,
        ownership,
      });

      expect(result.warnings).toEqual([]);
      expect(result.definitions.map((entry) => entry.name)).toEqual([
        "User",
        "UserId",
        "Status",
        "isReady",
        "currentUser",
        "buildCli",
        "Widget",
      ]);

      const buildCli = result.definitions.find((entry) => entry.name === "buildCli");
      expect(buildCli?.kind).toBe("function");
      expect(buildCli?.file).toBe("src/index.ts");
      expect(buildCli?.component_id).toBe("src");
      expect(buildCli?.range.start.line).toBe(16);
      expect(buildCli?.symbol_id).toMatch(/^ts:src\/buildCli@src\/index\.ts:\d+$/);

      expect(findByName(result.definitions, "User")).toBe(0);
      expect(findByName(result.definitions, "Widget")).toBe(6);
    },
    SYMBOLS_TS_TEST_TIMEOUT_MS,
  );

  it(
    "supports symbols find and def queries",
    async () => {
      const repoDir = await createTempRepoFromFixture();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await runCli([
        "node",
        "mycelium",
        "cg",
        "symbols",
        "find",
        "buildCli",
        "--json",
        "--repo",
        repoDir,
      ]);

      const findLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
      const findPayload = JSON.parse(findLine) as {
        ok: boolean;
        result?: { matches?: Array<{ symbol_id?: string; name?: string }> };
      };

      expect(findPayload.ok).toBe(true);
      expect(findPayload.result?.matches?.[0]?.name).toBe("buildCli");

      const symbolId = findPayload.result?.matches?.[0]?.symbol_id ?? "";
      expect(symbolId.length).toBeGreaterThan(0);

      await runCli([
        "node",
        "mycelium",
        "cg",
        "symbols",
        "def",
        symbolId,
        "--context",
        "1",
        "--json",
        "--repo",
        repoDir,
      ]);

      const defLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
      const defPayload = JSON.parse(defLine) as {
        ok: boolean;
        result?: { definition?: { symbol_id?: string }; snippet?: { lines?: string[] } };
      };

      expect(defPayload.ok).toBe(true);
      expect(defPayload.result?.definition?.symbol_id).toBe(symbolId);
      expect(defPayload.result?.snippet?.lines?.length).toBeGreaterThan(0);
    },
    SYMBOLS_TS_TEST_TIMEOUT_MS,
  );
});
