import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import type { ResourceConfig } from "./config.js";
import {
  resolveResourcesForFile,
  runManifestCompliance,
  type ResourceOwnershipResolver,
} from "./manifest-compliance.js";
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
      fallbackResource: "repo-root",
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
      fallbackResource: "repo-root",
      policy: "block",
    });

    expect(result.status).toBe("block");
    expect(result.violations).not.toHaveLength(0);
    expect(result.violations[0]?.reasons).toContain("resource_not_locked_for_write");
    expect(result.violations[0]?.reasons).toContain("file_not_declared_for_write");
  });

  it("reports component resources for violations across multiple components", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);

    await execa("git", ["checkout", "-b", "agent/003"], { cwd: repo });
    await fse.outputFile(path.join(repo, "apps", "api", "index.ts"), "export const api = true;\n");
    await fse.outputFile(path.join(repo, "apps", "web", "index.ts"), "export const web = true;\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "Add component changes"], { cwd: repo });

    const manifest: TaskManifest = {
      id: "003",
      name: "multi-component-change",
      description: "Update multiple components",
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

    const ownerResolver = (file: string): string | null => {
      if (file.startsWith("apps/api/")) return "component:api";
      if (file.startsWith("apps/web/")) return "component:web";
      return null;
    };

    const ownershipResolver: ResourceOwnershipResolver = (file) => {
      if (file.startsWith("apps/api/")) {
        return [
          {
            component_id: "api",
            component_name: "API",
            resource: "component:api",
            root: "apps/api",
          },
        ];
      }
      if (file.startsWith("apps/web/")) {
        return [
          {
            component_id: "web",
            component_name: "Web",
            resource: "component:web",
            root: "apps/web",
          },
        ];
      }
      return null;
    };

    const result = await runManifestCompliance({
      workspacePath: repo,
      mainBranch: "main",
      manifest,
      resources,
      fallbackResource: "repo-root",
      ownerResolver,
      ownershipResolver,
      policy: "warn",
    });

    expect(result.violations).toHaveLength(2);

    const violationsByPath = new Map(
      result.violations.map((violation) => [violation.path, violation]),
    );

    expect(violationsByPath.get("apps/api/index.ts")?.resources).toEqual(["component:api"]);
    expect(violationsByPath.get("apps/web/index.ts")?.resources).toEqual(["component:web"]);
    expect(violationsByPath.get("apps/api/index.ts")?.component_owners).toEqual([
      {
        component_id: "api",
        component_name: "API",
        resource: "component:api",
        root: "apps/api",
      },
    ]);
    expect(
      violationsByPath.get("apps/api/index.ts")?.guidance?.map((item) => item.action),
    ).toEqual(["expand_scope", "split_task"]);
  });
});

describe("resolveResourcesForFile", () => {
  const staticResources: ResourceConfig[] = [
    { name: "backend", description: "Backend", paths: ["src/**"] },
    { name: "docs", description: "Docs", paths: ["docs/**"] },
  ];
  const fallbackResource = "repo-root";

  it("prefers component resources when an owner is resolved", () => {
    const resources = resolveResourcesForFile("src/app.ts", {
      ownerResolver: (file) => (file.startsWith("src/") ? "component:api" : null),
      staticResources,
      fallbackResource,
    });

    expect(resources).toEqual(["component:api"]);
  });

  it("falls back to static resources when no owner is resolved", () => {
    const resources = resolveResourcesForFile("docs/guide.md", {
      ownerResolver: () => null,
      staticResources,
      fallbackResource,
    });

    expect(resources).toEqual(["docs"]);
  });

  it("uses the fallback resource when nothing matches", () => {
    const resources = resolveResourcesForFile("misc/notes.txt", {
      ownerResolver: () => null,
      staticResources,
      fallbackResource,
    });

    expect(resources).toEqual([fallbackResource]);
  });
});

async function createRepo(): Promise<string> {
  const repo = await fse.mkdtemp(path.join(os.tmpdir(), "manifest-compliance-"));

  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["checkout", "-B", "main"], { cwd: repo });
  await execa("git", ["config", "user.name", "tester"], { cwd: repo });
  await execa("git", ["config", "user.email", "tester@example.com"], { cwd: repo });

  await fse.outputFile(path.join(repo, "src", "app.ts"), "export const app = true;\n");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });

  return repo;
}
