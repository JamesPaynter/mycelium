import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import yaml from "js-yaml";

import { loadProjectConfig } from "../core/config-loader.js";
import type { ProjectConfig } from "../core/config.js";
import {
  createPathsContext,
  projectConfigPath,
  runSummaryReportPath,
  taskLockDerivationReportPath,
} from "../core/paths.js";
import type { TaskManifest } from "../core/task-manifest.js";
import { slugify } from "../core/utils.js";

export { readJsonl } from "./resume-drill.helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONTROL_PLANE_MINI_REPO_FIXTURE = path.resolve(
  __dirname,
  "../../test/fixtures/control-plane-mini-repo",
);

// =============================================================================
// TYPES
// =============================================================================

type WriteProjectConfigYamlArgs = {
  myceliumHome: string;
  repoDir: string;
  projectName?: string;
  controlPlane?: Partial<ProjectConfig["control_plane"]>;
  docker?: Partial<ProjectConfig["docker"]>;
};

// =============================================================================
// FIXTURE SETUP
// =============================================================================

export async function createTempRepoFromFixture(): Promise<{
  tmpRoot: string;
  repoDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "control-graph-e2e-"));
  const repoDir = path.join(tmpRoot, "repo");

  await fse.copy(CONTROL_PLANE_MINI_REPO_FIXTURE, repoDir);
  await writeMyceliumGitignore(repoDir);
  await initGitRepo(repoDir);

  return {
    tmpRoot,
    repoDir,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function writeMyceliumGitignore(repoDir: string): Promise<void> {
  const gitignorePath = path.join(repoDir, ".gitignore");
  const ignoreLine = ".mycelium/**";
  let existing = "";

  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // File does not exist yet.
  }

  if (existing.split("\n").some((line) => line.trim() === ignoreLine)) {
    return;
  }

  const prefix = existing.length > 0 ? existing.replace(/\s*$/, "") + "\n" : "";
  await fs.writeFile(gitignorePath, `${prefix}${ignoreLine}\n`, "utf8");
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "control-graph@example.com"], { cwd: repoDir });
  await execa("git", ["config", "user.name", "Control Graph Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

// =============================================================================
// PROJECT CONFIG
// =============================================================================

export async function writeProjectConfigYaml(
  args: WriteProjectConfigYamlArgs,
): Promise<{ projectName: string; configPath: string; config: ProjectConfig }> {
  const projectName = args.projectName ?? "control-graph-e2e";
  const paths = createPathsContext({ myceliumHome: args.myceliumHome });
  const configPath = projectConfigPath(projectName, paths);

  const configDoc: Record<string, unknown> = {
    repo_path: args.repoDir,
    main_branch: "main",
    tasks_dir: ".mycelium/tasks",
    doctor: 'node -e "process.exit(0)"',
    bootstrap: [],
    resources: [{ name: "repo", paths: ["**/*"] }],
    planner: { provider: "mock", model: "mock" },
    worker: { model: "mock" },
  };

  if (args.controlPlane) {
    configDoc.control_plane = args.controlPlane;
  }

  if (args.docker) {
    configDoc.docker = args.docker;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.dump(configDoc), "utf8");

  const config = loadProjectConfig(configPath);
  return { projectName, configPath, config };
}

// =============================================================================
// TASK WRITERS
// =============================================================================

export async function writeLegacyTask(
  tasksRoot: string,
  manifest: TaskManifest,
  specMarkdown: string,
): Promise<void> {
  const slug = slugify(manifest.name);
  const taskDir = path.join(tasksRoot, `${manifest.id}-${slug}`);

  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(taskDir, "spec.md"), specMarkdown, "utf8");
}

// =============================================================================
// REPORT READERS
// =============================================================================

export async function readControlPlaneRunSummary(repoDir: string, runId: string): Promise<unknown> {
  const reportPath = runSummaryReportPath(repoDir, runId);
  const raw = await fs.readFile(reportPath, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function readTaskLockDerivationReport(
  repoDir: string,
  runId: string,
  taskId: string,
): Promise<unknown> {
  const reportPath = taskLockDerivationReportPath(repoDir, runId, taskId);
  const raw = await fs.readFile(reportPath, "utf8");
  return JSON.parse(raw) as unknown;
}

// =============================================================================
// DEV SHIMS
// =============================================================================

export async function createMyceliumDevShimBinDir(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-dev-shim-"));
  const repoRoot = path.resolve(process.cwd());
  const shimPath = path.join(binDir, "mycelium");
  const distPath = path.join(repoRoot, "dist", "index.js");
  const tsxPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const mainPath = path.join(repoRoot, "src", "main.ts");
  const useStub = process.env.MYCELIUM_TEST_CG_STUB === "1";
  const stubScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
const hasJson = args.includes("--json");
const output = (payload) => {
  const text = hasJson ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
  process.stdout.write(text);
};

if (args[0] !== "cg") {
  console.error("Unsupported mycelium test command");
  process.exit(1);
}

const subcommand = args[1];
if (subcommand === "build") {
  output({
    ok: true,
    result: {
      base_sha: "test-sha",
      cache_dir: "test-cache",
      metadata: { schema_version: 1, built_at: "test" },
      reused: true,
    },
  });
  process.exit(0);
}

if (subcommand === "owner") {
  output({
    ok: true,
    result: {
      path: args[2] ?? "",
      owner: {
        component: { id: "acme-web-app", name: "@acme/web-app", roots: ["apps/web"] },
        root: "apps/web",
      },
    },
  });
  process.exit(0);
}

if (subcommand === "symbols" && args[2] === "find") {
  output({
    ok: true,
    result: {
      query: args[3] ?? "",
      total: 1,
      limit: 5,
      truncated: false,
      matches: [
        {
          symbol_id: "ts:acme-utils/formatUserId@packages/utils/src/index.ts:185",
        },
      ],
    },
  });
  process.exit(0);
}

if (subcommand === "symbols" && args[2] === "def") {
  output({
    ok: true,
    result: {
      symbol_id: args[3] ?? "",
      definition: { file: "packages/utils/src/index.ts" },
    },
  });
  process.exit(0);
}

console.error("Unhandled mycelium test command");
process.exit(1);
`;
  const hasDist = await fs
    .access(distPath)
    .then(() => true)
    .catch(() => false);
  const script = useStub
    ? stubScript
    : hasDist
      ? ["#!/usr/bin/env bash", `node "${distPath}" "$@"`, ""].join("\n")
      : ["#!/usr/bin/env bash", `node "${tsxPath}" "${mainPath}" "$@"`, ""].join("\n");

  await fs.writeFile(shimPath, script, "utf8");
  await fs.chmod(shimPath, 0o755);

  return binDir;
}
