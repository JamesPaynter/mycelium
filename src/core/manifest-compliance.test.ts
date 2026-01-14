import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import type { ResourceConfig } from "./config.js";
import { runManifestCompliance } from "./manifest-compliance.js";
import type { TaskManifest } from "./task-manifest.js";

describe("runManifestCompliance", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fse.remove(dir);
    }
    tempDirs.length = 0;
  });

  it("passes when all writes are declared", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);

    await execa("git", ["checkout", "-b", "agent/001"], { cwd: repo });
    await fse.outputFile(path.join(repo, "src", "app.ts"), "export const add = (a, b) => a + b;\n");
    await execa("git", ["commit", "-am", "Update app"], { cwd: repo });

    const manifest: TaskManifest = {
      id: "001",
      name: "update-app",
      description: "Update app",
      estimated_minutes: 10,
      dependencies: [],
      locks: { reads: [], writes: ["backend"] },
      files: { reads: [], writes: ["src/app.ts"] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    const resources: ResourceConfig[] = [
      { name: "backend", description: "Backend", paths: ["src/**"] },
    ];

    const reportPath = path.join(repo, "logs", "compliance.json");
    const result = await runManifestCompliance({
      workspacePath: repo,
      mainBranch: "main",
      manifest,
      resources,
      policy: "warn",
      reportPath,
    });

    expect(result.status).toBe("pass");
    expect(result.changedFiles.map((f) => f.path)).toContain("src/app.ts");
    expect(result.violations).toHaveLength(0);

    const report = await fse.readJson(reportPath);
    expect(report.status).toBe("pass");
    expect(report.changed_files[0]?.resources).toEqual(["backend"]);
  });

  it("blocks when writes touch undeclared resources/files", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);

    await execa("git", ["checkout", "-b", "agent/002"], { cwd: repo });
    await fse.outputFile(path.join(repo, "src", "service.ts"), "export const svc = true;\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "Add service"], { cwd: repo });

    const manifest: TaskManifest = {
      id: "002",
      name: "add-service",
      description: "Add service",
      estimated_minutes: 10,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    const resources: ResourceConfig[] = [
      { name: "backend", description: "Backend", paths: ["src/**"] },
    ];

    const result = await runManifestCompliance({
      workspacePath: repo,
      mainBranch: "main",
      manifest,
      resources,
      policy: "block",
    });

    expect(result.status).toBe("block");
    expect(result.violations).not.toHaveLength(0);
    expect(result.violations[0]?.reasons).toContain("resource_not_locked_for_write");
    expect(result.violations[0]?.reasons).toContain("file_not_declared_for_write");
  });
});

async function createRepo(): Promise<string> {
  const repo = await fse.mkdtemp(path.join(os.tmpdir(), "manifest-compliance-"));

  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["checkout", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.name", "tester"], { cwd: repo });
  await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repo });

  await fse.outputFile(path.join(repo, "src", "app.ts"), "export const app = true;\n");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });

  return repo;
}
