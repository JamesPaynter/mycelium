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
  dockerfile: ./templates/Dockerfile
  build_context: ..
`,
    );

    try {
      const config = loadProjectConfig(configPath);

      expect(config.repo_path).toBe("/tmp/repo-path");
      expect(config.docker.dockerfile).toBe(
        path.resolve(path.dirname(configPath), "./templates/Dockerfile"),
      );
      expect(config.docker.build_context).toBe(path.resolve(path.dirname(configPath), ".."));
      expect(config.docker.user).toBe("worker");
      expect(config.docker.network_mode).toBe("bridge");
      expect(config.docker.memory_mb).toBeUndefined();
      expect(config.task_branch_prefix).toBe("agent/");
      expect(config.manifest_enforcement).toBe("warn");
      expect(config.test_paths.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) {
        delete process.env.PROJECT_REPO_PATH;
      } else {
        process.env.PROJECT_REPO_PATH = original;
      }
    }
  });

  it("parses lint command and timeout when provided", () => {
    const configPath = writeConfig(
      "lint.yaml",
      `
repo_path: /tmp/repo
main_branch: development-codex
lint: "npm run lint"
lint_timeout: 600
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

    const config = loadProjectConfig(configPath);

    expect(config.lint).toBe("npm run lint");
    expect(config.lint_timeout).toBe(600);
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

  it("parses docker limits and network mode overrides", () => {
    const configPath = writeConfig(
      "limits.yaml",
      `
repo_path: /tmp/repo
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
  image: custom-worker:latest
  network_mode: none
  user: builder
  memory_mb: 512
  cpu_quota: 75000
  pids_limit: 128
`,
    );

    const config = loadProjectConfig(configPath);

    expect(config.docker.image).toBe("custom-worker:latest");
    expect(config.docker.user).toBe("builder");
    expect(config.docker.network_mode).toBe("none");
    expect(config.docker.memory_mb).toBe(512);
    expect(config.docker.cpu_quota).toBe(75_000);
    expect(config.docker.pids_limit).toBe(128);
  });

  it("applies doctor canary defaults", () => {
    const configPath = writeConfig(
      "defaults.yaml",
      `
repo_path: /tmp/repo
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

    const config = loadProjectConfig(configPath);

    expect(config.doctor_canary).toEqual({
      mode: "env",
      env_var: "ORCH_CANARY",
      warn_on_unexpected_pass: true,
    });
  });

  it("maps control_graph to the control_plane config", () => {
    const configPath = writeConfig(
      "control-graph.yaml",
      `
repo_path: /tmp/repo
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
control_graph:
  enabled: true
  lock_mode: derived
  checks:
    mode: enforce
`,
    );

    const config = loadProjectConfig(configPath);

    expect(config.control_plane.enabled).toBe(true);
    expect(config.control_plane.lock_mode).toBe("derived");
    expect(config.control_plane.checks.mode).toBe("enforce");
  });

  it("defaults lock_mode to derived when control_graph is enabled", () => {
    const configPath = writeConfig(
      "control-graph-default-lock.yaml",
      `
repo_path: /tmp/repo
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
control_graph:
  enabled: true
`,
    );

    const config = loadProjectConfig(configPath);

    expect(config.control_plane.enabled).toBe(true);
    expect(config.control_plane.lock_mode).toBe("derived");
  });
});
