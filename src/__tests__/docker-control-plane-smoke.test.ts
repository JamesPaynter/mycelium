import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import type { ControlPlaneJsonEnvelope } from "../control-plane/cli/output.js";

// =============================================================================
// TEST SETUP
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, "../../test/fixtures/control-plane-mini-repo");
const DOCKER_IMAGE = "mycelium-worker:control-plane-smoke";
const DOCKERFILE_PATH = path.resolve(process.cwd(), "templates/Dockerfile");
const BUILD_CONTEXT = process.cwd();
const REPO_MOUNT_PATH = "/workspace/repo";

const dockerGate = resolveDockerGate();
if (!dockerGate.enabled) {
  console.warn(`Skipping Docker control plane smoke test: ${dockerGate.reason}`);
}

const describeDocker = dockerGate.enabled ? describe : describe.skip;

// =============================================================================
// TESTS
// =============================================================================

describeDocker("docker-mode control plane smoke", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const dir of tempRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it("runs control plane commands inside the worker image", async () => {
    await ensureDockerAvailable();
    await ensureWorkerImage();

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-smoke-"));
    tempRoots.push(tempRoot);

    const repoDir = path.join(tempRoot, "repo");
    await fse.copy(FIXTURE_REPO, repoDir);
    await initGitRepo(repoDir);

    const helpResult = await runMyceliumInDocker(["cp", "--help"]);
    expect(helpResult.stdout).toContain("control-plane");

    const buildResult = await runMyceliumInDocker(
      ["cp", "build", "--json", "--repo", REPO_MOUNT_PATH],
      { repoDir },
    );
    const buildEnvelope = parseJsonEnvelope(buildResult.stdout, "cp build");
    expect(buildEnvelope.ok).toBe(true);

    const listResult = await runMyceliumInDocker(
      ["cp", "components", "list", "--json", "--repo", REPO_MOUNT_PATH],
      { repoDir },
    );
    const listEnvelope = parseJsonEnvelope<unknown[]>(listResult.stdout, "cp components list");
    expect(listEnvelope.ok).toBe(true);
    if (!listEnvelope.ok) {
      throw new Error(`cp components list failed: ${listEnvelope.error.message}`);
    }
    expect(Array.isArray(listEnvelope.result)).toBe(true);
    expect(listEnvelope.result.length).toBeGreaterThan(0);
  }, 180_000);
});

// =============================================================================
// HELPERS
// =============================================================================

type ControlPlaneEnvelope<T> = ControlPlaneJsonEnvelope<T>;

function resolveDockerGate(): { enabled: boolean; reason?: string } {
  const flag = process.env.RUN_DOCKER_TESTS;
  if (!flag || !["1", "true", "yes", "on"].includes(flag.toLowerCase())) {
    return { enabled: false, reason: "RUN_DOCKER_TESTS=1 not set" };
  }
  const availability = probeDockerAvailability();
  if (!availability.available) {
    return {
      enabled: false,
      reason: availability.reason ?? "Docker is not available (install/start Docker).",
    };
  }
  return { enabled: true };
}

async function ensureDockerAvailable(): Promise<void> {
  const availability = probeDockerAvailability();
  if (availability.available) return;

  const detail = availability.reason ?? "docker info failed";
  throw new Error(`Docker is required for this test: ${detail}`);
}

function probeDockerAvailability(): { available: boolean; reason?: string } {
  const res = spawnSync("docker", ["info"], { stdio: "pipe" });
  if (res.status === 0) return { available: true };

  const stderr = res.stderr?.toString("utf8").trim();
  const stdout = res.stdout?.toString("utf8").trim();
  const message =
    res.error?.message ??
    (stderr && stderr.length > 0 ? stderr : undefined) ??
    (stdout && stdout.length > 0 ? stdout : undefined);

  return { available: false, reason: message };
}

async function ensureWorkerImage(): Promise<void> {
  await execa("docker", ["build", "-f", DOCKERFILE_PATH, "-t", DOCKER_IMAGE, BUILD_CONTEXT], {
    stdio: "inherit",
  });
}

async function runMyceliumInDocker(args: string[], options: { repoDir?: string } = {}) {
  const dockerArgs = ["run", "--rm", ...resolveDockerUserArgs(), "--entrypoint", "mycelium"];

  if (options.repoDir) {
    const repoRoot = path.resolve(options.repoDir);
    // Control plane builds write model artifacts under .mycelium in the repo.
    dockerArgs.push("-v", `${repoRoot}:${REPO_MOUNT_PATH}:rw`);
  }

  dockerArgs.push(DOCKER_IMAGE, ...args);
  return execa("docker", dockerArgs);
}

function resolveDockerUserArgs(): string[] {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return [];
  }

  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execa("git", ["init"], { cwd: repoDir });
  await execa("git", ["config", "user.email", "docker-control-plane@example.com"], {
    cwd: repoDir,
  });
  await execa("git", ["config", "user.name", "Docker Control Plane Tester"], { cwd: repoDir });
  await execa("git", ["add", "-A"], { cwd: repoDir });
  await execa("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execa("git", ["checkout", "-B", "main"], { cwd: repoDir });
}

function parseJsonEnvelope<T>(stdout: string, label: string): ControlPlaneEnvelope<T> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Expected JSON output for ${label}, but received empty stdout.`);
  }

  try {
    return JSON.parse(trimmed) as ControlPlaneEnvelope<T>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON output for ${label}: ${message}`);
  }
}
