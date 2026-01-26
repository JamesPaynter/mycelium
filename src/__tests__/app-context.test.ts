import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAppContext } from "../app/config/load-app-context.js";

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;

  for (const key of ENV_VARS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});



// =============================================================================
// HELPERS
// =============================================================================

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-context-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}



// =============================================================================
// TESTS
// =============================================================================

describe("loadAppContext", () => {
  it("resolves repo config + paths without mutating env", async () => {
    const repo = makeRepo();
    delete process.env.MYCELIUM_HOME;

    const result = await loadAppContext({ cwd: repo, initIfMissing: true });

    expect(result.created).toBe(true);
    expect(result.appContext.projectName).toBe(path.basename(repo));
    expect(result.appContext.repoPath).toBe(repo);
    expect(result.appContext.configPath).toBe(path.join(repo, ".mycelium", "config.yaml"));
    expect(result.appContext.myceliumHome).toBe(path.join(repo, ".mycelium"));
    expect(process.env.MYCELIUM_HOME).toBeUndefined();
  });

  it("respects MYCELIUM_HOME overrides", async () => {
    const repo = makeRepo();
    const override = path.join(repo, "tmp-myc-home");
    process.env.MYCELIUM_HOME = override;

    const result = await loadAppContext({ cwd: repo, initIfMissing: true });

    expect(result.appContext.myceliumHome).toBe(path.resolve(override));
    expect(process.env.MYCELIUM_HOME).toBe(override);
  });
});
