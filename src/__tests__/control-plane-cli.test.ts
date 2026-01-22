import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../cli/index.js";

const HELP_ERROR_CODE = "commander.helpDisplayed";



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
    .map(([chunk]) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")))
    .join("");
}

function installExitOverride(command: Command): void {
  command.exitOverride();

  for (const child of command.commands) {
    installExitOverride(child);
  }
}



// =============================================================================
// TESTS
// =============================================================================

describe("control-plane CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("renders help for the cp alias", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "mycelium", "cp", "--help"], { allowHelp: true });

    const output = collectStdout(writeSpy);
    expect(output).toContain("control-plane");
  });

  it("prints a JSON error envelope for stub commands", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["node", "mycelium", "cp", "components", "list", "--json"]);

    const jsonLine = logSpy.mock.calls.map((call) => call.join(" ")).pop() ?? "";
    const payload = JSON.parse(jsonLine) as { ok: boolean; error?: { code?: string; message?: string } };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("MODEL_NOT_BUILT");
    expect(payload.error?.message).toEqual(expect.any(String));
    expect(process.exitCode).toBe(1);
  });
});
