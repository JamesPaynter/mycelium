import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunState, type ControlPlaneSnapshot } from "../core/state.js";
import type { ControlPlaneModel } from "../control-plane/model/schema.js";
import { createUiRouter } from "../ui/router.js";

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const staticRoot = path.resolve("src/ui/static");

afterEach(async () => {
  for (const server of servers) {
    await closeServer(server);
  }
  servers.length = 0;

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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRunState(params: {
  homeDir: string;
  projectName: string;
  runId: string;
  repoPath: string;
  controlPlane?: ControlPlaneSnapshot;
}): void {
  const stateDir = path.join(params.homeDir, "state", params.projectName);
  fs.mkdirSync(stateDir, { recursive: true });

  const state = createRunState({
    runId: params.runId,
    project: params.projectName,
    repoPath: params.repoPath,
    mainBranch: "main",
    taskIds: [],
    controlPlane: params.controlPlane,
  });

  const statePath = path.join(stateDir, `run-${params.runId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function writeRepoFile(repoRoot: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function writeControlPlaneModel(
  repoRoot: string,
  baseSha: string,
  model: ControlPlaneModel,
): void {
  const modelDir = path.join(repoRoot, ".mycelium", "control-plane", "models", baseSha);
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "model.json"), JSON.stringify(model, null, 2), "utf8");
}

function buildCodeGraphUrl(baseUrl: string, projectName: string, runId: string): URL {
  return new URL(
    `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(runId)}/code-graph`,
    baseUrl,
  );
}

function startServer(
  router: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => router(req, res));
    servers.push(server);

    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };

    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine UI server address."));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}



// =============================================================================
// TESTS
// =============================================================================

describe("UI static routes", () => {
  it("serves the Garden and Map view tabs from index.html", async () => {
    const router = createUiRouter({
      projectName: "demo-project",
      runId: "run-400",
      staticRoot,
    });
    const { baseUrl } = await startServer(router);

    const response = await fetch(new URL("/?view=garden", baseUrl));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain(">List<");
    expect(body).toContain(">Garden<");
    expect(body).toContain(">Map<");
  });
});

describe("UI code graph API", () => {
  it("returns a MODEL_NOT_FOUND error with a hint when no model is present", async () => {
    const homeDir = makeTempDir("ui-code-graph-missing-");
    process.env.MYCELIUM_HOME = homeDir;

    const repoRoot = path.join(homeDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });

    const projectName = "demo-project";
    const runId = "run-500";
    const baseSha = "abc1234";

    writeRunState({
      homeDir,
      projectName,
      runId,
      repoPath: repoRoot,
      controlPlane: { enabled: true, base_sha: baseSha },
    });

    const router = createUiRouter({ projectName, runId, staticRoot });
    const { baseUrl } = await startServer(router);

    const response = await fetch(buildCodeGraphUrl(baseUrl, projectName, runId));
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("MODEL_NOT_FOUND");
    expect(payload.error.hint).toContain(baseSha);
  });

  it("returns components, deps, and stats when a model exists", async () => {
    const homeDir = makeTempDir("ui-code-graph-present-");
    process.env.MYCELIUM_HOME = homeDir;

    const repoRoot = path.join(homeDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });

    writeRepoFile(repoRoot, "src/component-a/index.ts", "export const alpha = 1;\n");
    writeRepoFile(repoRoot, "src/component-b/index.ts", "export const beta = 2;\n");

    const projectName = "demo-project";
    const runId = "run-501";
    const baseSha = "def5678";

    const model: ControlPlaneModel = {
      components: [
        { id: "component-a", name: "Component A", roots: ["src/component-a"], kind: "app" },
        { id: "component-b", name: "Component B", roots: ["src/component-b"], kind: "lib" },
      ],
      ownership: { roots: [] },
      deps: {
        edges: [
          {
            from_component: "component-a",
            to_component: "component-b",
            kind: "ts-import",
            confidence: "high",
          },
        ],
      },
      symbols: [],
      symbols_ts: { definitions: [] },
    };

    writeControlPlaneModel(repoRoot, baseSha, model);

    writeRunState({
      homeDir,
      projectName,
      runId,
      repoPath: repoRoot,
      controlPlane: { enabled: true, base_sha: baseSha },
    });

    const router = createUiRouter({ projectName, runId, staticRoot });
    const { baseUrl } = await startServer(router);

    const response = await fetch(buildCodeGraphUrl(baseUrl, projectName, runId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.result.base_sha).toBe(baseSha);
    expect(payload.result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "component-a",
          roots: ["src/component-a"],
          kind: "app",
        }),
        expect.objectContaining({
          id: "component-b",
          roots: ["src/component-b"],
          kind: "lib",
        }),
      ]),
    );
    expect(payload.result.deps).toEqual([{ from: "component-a", to: "component-b" }]);
    expect(payload.result.stats["component-a"].code_files).toBeGreaterThan(0);
    expect(payload.result.stats["component-b"].code_files).toBeGreaterThan(0);
  });
});
