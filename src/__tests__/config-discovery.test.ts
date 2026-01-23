import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectConfigPath } from "../core/config-discovery.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-discovery-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("resolveProjectConfigPath", () => {
  it("creates a repo config when missing", () => {
    const repo = makeRepo();
    const result = resolveProjectConfigPath({
      projectName: "demo",
      cwd: repo,
      initIfMissing: true,
    });

    expect(result.source).toBe("repo");
    expect(result.created).toBe(true);
    expect(fs.existsSync(result.configPath)).toBe(true);

    const config = fs.readFileSync(result.configPath, "utf8");
    expect(config).toContain("tasks_dir: .mycelium/tasks");
    expect(config).toContain("planning_dir: .mycelium/planning");
    expect(config).toContain("doctor: ./.mycelium/doctor.sh");
    expect(config).toContain("ui:");
    expect(config).toContain("open_browser: true");
    expect(config).toContain("planner:");
    expect(config).toContain("worker:");

    const doctorScript = path.join(repo, ".mycelium", "doctor.sh");
    expect(fs.existsSync(doctorScript)).toBe(true);
    expect(fs.readFileSync(doctorScript, "utf8")).toContain("Doctor not configured");

    const gitignore = path.join(repo, ".mycelium", ".gitignore");
    expect(fs.readFileSync(gitignore, "utf8")).toContain("Managed by Mycelium");

    const planPath = path.join(
      repo,
      ".mycelium",
      "planning",
      "002-implementation",
      "implementation-plan.md",
    );
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, "utf8")).toContain("# Implementation Plan");
  });

  it("uses an existing repo config without recreating", () => {
    const repo = makeRepo();
    const repoConfigDir = path.join(repo, ".mycelium");
    const configPath = path.join(repoConfigDir, "config.yaml");
    fs.mkdirSync(repoConfigDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "repo_path: ..",
        "main_branch: main",
        "doctor: npm test",
        "resources:",
        "  - name: repo",
        '    paths: ["**/*"]',
        "planner:",
        "  provider: codex",
        "  model: o3",
        "worker:",
        "  model: gpt-5.1-codex-max",
        "",
      ].join("\n"),
      "utf8",
    );

    const nested = path.join(repo, "nested", "dir");
    fs.mkdirSync(nested, { recursive: true });

    const result = resolveProjectConfigPath({
      projectName: "demo",
      cwd: nested,
      initIfMissing: true,
    });

    expect(result.source).toBe("repo");
    expect(result.created).toBe(false);
    expect(result.configPath).toBe(configPath);
  });
});
