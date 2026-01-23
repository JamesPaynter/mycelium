import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCommand } from "../cli/init.js";

describe("acceptance: mycelium init", () => {
  let repoDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-init-"));
    await fs.mkdir(path.join(repoDir, ".git"));

    originalCwd = process.cwd();
    process.chdir(repoDir);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await fs.rm(repoDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("creates repo-local config + support files on first run", async () => {
    await initCommand({ force: false });

    expect(errorSpy).not.toHaveBeenCalled();

    const configPath = path.join(repoDir, ".mycelium", "config.yaml");
    const gitignorePath = path.join(repoDir, ".mycelium", ".gitignore");
    const doctorPath = path.join(repoDir, ".mycelium", "doctor.sh");
    const planPath = path.join(
      repoDir,
      ".mycelium",
      "planning",
      "002-implementation",
      "implementation-plan.md",
    );

    const config = await fs.readFile(configPath, "utf8");
    expect(config).toContain("# Mycelium project configuration");
    expect(config).toContain("repo_path:");
    expect(config).toContain("tasks_dir: .mycelium/tasks");
    expect(config).toContain("planning_dir: .mycelium/planning");
    expect(config).toContain("ui:");
    expect(config).toContain("open_browser: true");

    const gitignore = await fs.readFile(gitignorePath, "utf8");
    expect(gitignore).toContain("Managed by Mycelium");

    const doctor = await fs.readFile(doctorPath, "utf8");
    expect(doctor).toContain("Doctor not configured");

    const plan = await fs.readFile(planPath, "utf8");
    expect(plan).toContain("# Implementation Plan");

    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/Created Mycelium config/i);
  });

  it("does not overwrite existing config unless --force is provided", async () => {
    await initCommand({ force: false });

    const configPath = path.join(repoDir, ".mycelium", "config.yaml");
    const original = await fs.readFile(configPath, "utf8");

    const marker = "# user edited\n";
    await fs.writeFile(configPath, `${marker}${original}`, "utf8");

    logSpy.mockClear();
    await initCommand({ force: false });

    const afterNoForce = await fs.readFile(configPath, "utf8");
    expect(afterNoForce.startsWith(marker)).toBe(true);

    logSpy.mockClear();
    await initCommand({ force: true });

    const afterForce = await fs.readFile(configPath, "utf8");
    expect(afterForce.startsWith(marker)).toBe(false);
    expect(afterForce).toContain("# Mycelium project configuration");

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toMatch(/Overwrote Mycelium config/i);
  });
});
