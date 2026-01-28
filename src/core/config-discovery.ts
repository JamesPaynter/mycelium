import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UserFacingError, USER_FACING_ERROR_CODES } from "./errors.js";
import { buildMyceliumGitignore } from "./mycelium-gitignore.js";
import { projectConfigPath } from "./paths.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const REPO_CONFIG_DIR = ".mycelium";
const REPO_CONFIG_FILE = "config.yaml";
const DEFAULT_TASKS_DIR = `${REPO_CONFIG_DIR}/tasks`;
const DEFAULT_PLANNING_DIR = `${REPO_CONFIG_DIR}/planning`;
const DEFAULT_DOCTOR_SCRIPT = `${REPO_CONFIG_DIR}/doctor.sh`;

// =============================================================================
// TYPES
// =============================================================================

export type ConfigSource = "explicit" | "repo" | "home";

export type ConfigResolution = {
  configPath: string;
  source: ConfigSource;
  created: boolean;
};

export type InitResult = {
  repoRoot: string;
  configPath: string;
  status: "created" | "exists" | "overwritten";
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function resolveProjectConfigPath(args: {
  projectName: string;
  explicitPath?: string;
  cwd?: string;
  initIfMissing?: boolean;
}): ConfigResolution {
  const cwd = args.cwd ?? process.cwd();

  if (args.explicitPath) {
    return {
      configPath: path.resolve(args.explicitPath),
      source: "explicit",
      created: false,
    };
  }

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const repoConfig = repoConfigPath(repoRoot);

    if (fs.existsSync(repoConfig)) {
      return { configPath: repoConfig, source: "repo", created: false };
    }

    if (args.initIfMissing ?? true) {
      const init = initRepoConfig({ cwd: repoRoot, force: false });
      return {
        configPath: init.configPath,
        source: "repo",
        created: init.status !== "exists",
      };
    }

    return { configPath: repoConfig, source: "repo", created: false };
  }

  return {
    configPath: projectConfigPath(args.projectName),
    source: "home",
    created: false,
  };
}

export function initRepoConfig(args: { cwd?: string; force?: boolean }): InitResult {
  const cwd = args.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    throw createMissingRepoError(cwd);
  }

  const configPath = repoConfigPath(repoRoot);
  const hasConfig = fs.existsSync(configPath);
  const force = args.force ?? false;

  const configDir = path.dirname(configPath);
  ensureRepoLayout(repoRoot, configDir, { force });

  if (hasConfig && !force) {
    return { repoRoot, configPath, status: "exists" };
  }

  writeDefaultConfig(configPath);

  const status = hasConfig && force ? "overwritten" : "created";
  return { repoRoot, configPath, status };
}

export function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function repoConfigPath(repoRoot: string): string {
  return path.join(repoRoot, REPO_CONFIG_DIR, REPO_CONFIG_FILE);
}

// =============================================================================
// INTERNALS
// =============================================================================

function createMissingRepoError(cwd: string): UserFacingError {
  const resolvedCwd = path.resolve(cwd);
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.config,
    title: "Repository not found.",
    message: `No git repository found in ${resolvedCwd} or its parent directories.`,
    hint: "Run this command inside a git repo (or run `git init` first).",
  });
}

function ensureRepoLayout(repoRoot: string, configDir: string, opts: { force: boolean }): void {
  fs.mkdirSync(configDir, { recursive: true });
  ensureTasksDir(repoRoot);
  ensurePlanningDirs(repoRoot, opts);
  ensureLocalGitignore(repoRoot, configDir, opts);
  ensureDoctorScript(path.join(repoRoot, DEFAULT_DOCTOR_SCRIPT), opts);
}

function ensureTasksDir(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, DEFAULT_TASKS_DIR), { recursive: true });
}

function ensurePlanningDirs(repoRoot: string, opts: { force: boolean }): void {
  const planningRoot = path.join(repoRoot, DEFAULT_PLANNING_DIR);
  fs.mkdirSync(planningRoot, { recursive: true });
  fs.mkdirSync(path.join(planningRoot, "002-implementation"), { recursive: true });
  fs.mkdirSync(path.join(planningRoot, "sessions"), { recursive: true });

  const planPath = path.join(planningRoot, "002-implementation", "implementation-plan.md");
  if (!fs.existsSync(planPath) || opts.force) {
    fs.writeFileSync(planPath, defaultImplementationPlanStub(), "utf8");
  }
}

function ensureLocalGitignore(repoRoot: string, configDir: string, opts: { force: boolean }): void {
  const ignorePath = path.join(configDir, ".gitignore");
  if (fs.existsSync(ignorePath) && !opts.force) return;

  const content = buildMyceliumGitignore({ includeSessions: true });
  fs.writeFileSync(ignorePath, content, "utf8");
}

function ensureDoctorScript(scriptPath: string, opts: { force: boolean }): void {
  if (fs.existsSync(scriptPath) && !opts.force) return;

  const content = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'if [[ "${ORCH_CANARY:-}" == "1" ]]; then',
    '  echo "ORCH_CANARY=1: failing as expected"',
    "  exit 1",
    "fi",
    "",
    'echo "Doctor not configured. Update .mycelium/doctor.sh"',
    "exit 0",
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, content, "utf8");
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // Ignore chmod failures (e.g., on Windows).
  }
}

function writeDefaultConfig(configPath: string): void {
  const myceliumRoot = resolveMyceliumPackageRoot();
  const dockerfile = path.join(myceliumRoot, "templates", "Dockerfile");
  const buildContext = myceliumRoot;

  fs.writeFileSync(configPath, defaultRepoConfigYaml({ dockerfile, buildContext }), "utf8");
}

function resolveMyceliumPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works for both:
  // - repo dev (`tsx src/main.ts` => src/core/...)
  // - packaged install (`node dist/index.js` => dist/core/...)
  return path.resolve(here, "..", "..");
}

function defaultRepoConfigYaml(args: { dockerfile: string; buildContext: string }): string {
  return [
    "# Mycelium project configuration (repo-scoped)",
    "#",
    "# This file is loaded by default from <repo>/.mycelium/config.yaml.",
    "# You can also keep configs in ~/.mycelium/projects/<project>.yaml.",
    "",
    "# Path to the target repo on your machine (env vars like ${HOME} are allowed).",
    "# Relative paths are resolved from the directory containing this YAML file.",
    "repo_path: ..",
    "",
    "# Integration branch the orchestrator merges into",
    "main_branch: main",
    "",
    "# Task branches are created as: <task_branch_prefix><id>-<name>",
    "task_branch_prefix: agent/",
    "",
    "# Where Mycelium stores planned task specs + manifests within the target repo",
    `tasks_dir: ${DEFAULT_TASKS_DIR}`,
    "",
    "# Where Mycelium stores planning artifacts (implementation plan, sessions, etc.)",
    `planning_dir: ${DEFAULT_PLANNING_DIR}`,
    "",
    "# Manifest enforcement policy: off | warn | block",
    "manifest_enforcement: warn",
    "",
    "# Limits",
    "max_parallel: 4",
    "max_retries: 20",
    "timeout_minutes: 120",
    "",
    "budgets:",
    "  mode: warn",
    "  # max_tokens_per_task: 200000",
    "  # max_cost_per_run: 25",
    "",
    "# Cleanup after successful integration doctor (never | on_success).",
    "cleanup:",
    "  workspaces: never",
    "  containers: never",
    "",
    "# UI server settings (mycelium ui / run/resume)",
    "ui:",
    "  enabled: true",
    "  port: 8787",
    "  open_browser: true",
    "  refresh_ms: 2000",
    "",
    "# Optional lint command that runs before doctor.",
    "# lint: npm run lint",
    "# lint_timeout: 600",
    "",
    "# Doctor command runs on the integration branch after each batch.",
    "doctor: ./.mycelium/doctor.sh",
    "# doctor_timeout: 900",
    "",
    "# Doctor canary reruns the doctor with an env var set to ensure it can fail.",
    "doctor_canary:",
    "  mode: env",
    "  env_var: ORCH_CANARY",
    "  warn_on_unexpected_pass: true",
    "",
    "# Optional bootstrap commands executed inside each worker container before Codex runs.",
    "bootstrap:",
    "  - npm ci",
    "",
    "# Define abstract resources for safe scheduling. Start broad, tighten over time.",
    "resources:",
    "  - name: repo",
    "    description: All repo files (broad default)",
    "    paths:",
    '      - "**/*"',
    "",
    "# Control graph settings (repo navigation + compliance)",
    "control_graph:",
    "  enabled: true",
    "  resources_mode: prefer-derived",
    "  lock_mode: derived",
    "  scope_mode: enforce",
    "  checks:",
    "    mode: enforce",
    "  surface_locks:",
    "    enabled: true",
    "",
    "planner:",
    "  provider: codex",
    "  model: o3",
    "",
    "worker:",
    "  model: gpt-5.1-codex-max",
    "  checkpoint_commits: true",
    "  # reasoning_effort: medium",
    "",
    "# Optional validators. Set mode: block to prevent merges on failure.",
    "# test_validator:",
    "#   mode: warn",
    "#   provider: openai",
    "#   model: o3",
    "# style_validator:",
    "#   mode: warn",
    "#   provider: openai",
    "#   model: o3",
    "# architecture_validator:",
    "#   mode: warn",
    "#   provider: openai",
    "#   model: o3",
    '#   docs_glob: ".mycelium/planning/**/architecture*.md"',
    "#   fail_if_docs_missing: false",
    "# doctor_validator:",
    "#   mode: warn",
    "#   provider: openai",
    "#   model: o3",
    "#   run_every_n_tasks: 10",
    "",
    "# Docker worker image (paths resolve relative to this file when not absolute)",
    "docker:",
    `  image: mycelium-worker:latest`,
    `  dockerfile: ${args.dockerfile}`,
    `  build_context: ${args.buildContext}`,
    "  user: worker",
    "  network_mode: bridge",
    "  # memory_mb: 2048",
    "  # cpu_quota: 100000",
    "  # pids_limit: 512",
    "",
  ].join("\n");
}

function defaultImplementationPlanStub(): string {
  return [
    "# Implementation Plan",
    "",
    "This is a starter implementation plan created by `mycelium init`.",
    "",
    "## Goal",
    "Describe the high-level business/engineering outcome.",
    "",
    "## Scope",
    "- In scope: ...",
    "- Out of scope: ...",
    "",
    "## Constraints",
    "- Budget / time / dependencies / systems / regulatory constraints",
    "",
    "## Acceptance Criteria (system-level)",
    'Write these as: "This is what I expect to happen".',
    "",
    "## Risks",
    "- ...",
    "",
    "## Implementation Sketch",
    "- ...",
    "",
  ].join("\n");
}
