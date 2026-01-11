import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "../core/config-loader.js";
import { ConfigError } from "../core/errors.js";

const tempDirs: string[] = [];

function writeConfig(filename: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-loader-"));
  tempDirs.push(dir);

  const configPath = path.join(dir, filename);
  fs.writeFileSync(configPath, contents, "utf8");
  return configPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("loadProjectConfig", () => {
  it("expands environment variables and resolves relative paths", () => {
    const original = process.env.PROJECT_REPO_PATH;
    process.env.PROJECT_REPO_PATH = "/tmp/repo-path";

    const configPath = writeConfig(
      "project.yaml",
      `
repo_path: \${PROJECT_REPO_PATH}
main_branch: development-codex
doctor: "npm test"
resources:
  - name: backend
    paths: ["server/*"]
planner:
  provider: openai
  model: o3
worker:
  model: gpt-5.1-codex-max
docker:
  dockerfile: ./templates/worker.Dockerfile
  build_context: ..
`,
    );

    try {
      const config = loadProjectConfig(configPath);

      expect(config.repo_path).toBe("/tmp/repo-path");
      expect(config.docker.dockerfile).toBe(
        path.resolve(path.dirname(configPath), "./templates/worker.Dockerfile"),
      );
      expect(config.docker.build_context).toBe(path.resolve(path.dirname(configPath), ".."));
      expect(config.task_branch_prefix).toBe("agent/");
    } finally {
      if (original === undefined) {
        delete process.env.PROJECT_REPO_PATH;
      } else {
        process.env.PROJECT_REPO_PATH = original;
      }
    }
  });

  it("throws a helpful error when an environment variable is missing", () => {
    const configPath = writeConfig(
      "missing-env.yaml",
      `
repo_path: \${MISSING_PROJECT_REPO}
main_branch: development-codex
doctor: "npm test"
resources:
  - name: backend
    paths: ["server/*"]
planner:
  provider: openai
  model: o3
worker:
  model: gpt-5.1-codex-max
`,
    );

    let error: unknown;
    try {
      loadProjectConfig(configPath);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("MISSING_PROJECT_REPO");
    expect(message).toContain(configPath);
    expect(message).toContain("repo_path");
  });

  it("surfaces validation errors with key paths and expected types", () => {
    const configPath = writeConfig(
      "invalid.yaml",
      `
repo_path: /tmp/repo
main_branch: development-codex
doctor: "npm test"
max_parallel: "ten"
resources:
  - name: backend
    paths: ["server/*"]
planner:
  provider: openai
  model: o3
worker:
  model: gpt-5.1-codex-max
`,
    );

    let error: unknown;
    try {
      loadProjectConfig(configPath);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("Invalid project config");
    expect(message).toContain("max_parallel");
    expect(message).toContain("Expected number");
  });
});
