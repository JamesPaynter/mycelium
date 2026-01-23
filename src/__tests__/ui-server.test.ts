import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunState } from "../core/state.js";
import { startUiServer, type UiServerHandle } from "../ui/server.js";

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const tempDirs: string[] = [];
const servers: UiServerHandle[] = [];

afterEach(async () => {
  for (const server of servers) {
    await server.close();
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

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-server-"));
  tempDirs.push(dir);
  return dir;
}

function writeRunState(
  root: string,
  projectName: string,
  runId: string,
  taskIds: string[],
): void {
  const stateDir = path.join(root, "state", projectName);
  fs.mkdirSync(stateDir, { recursive: true });

  const state = createRunState({
    runId,
    project: projectName,
    repoPath: root,
    mainBranch: "main",
    taskIds,
  });

  const statePath = path.join(stateDir, `run-${runId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function ensureRunLogsDir(root: string, projectName: string, runId: string): string {
  const dir = path.join(root, "logs", projectName, `run-${runId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureTaskEventsLog(
  root: string,
  projectName: string,
  runId: string,
  taskId: string,
  taskSlug: string,
): string {
  const runDir = ensureRunLogsDir(root, projectName, runId);
  const taskDir = path.join(runDir, "tasks", `${taskId}-${taskSlug}`);
  fs.mkdirSync(taskDir, { recursive: true });
  return path.join(taskDir, "events.jsonl");
}

function writeJsonlFile(filePath: string, lines: string[]): void {
  const content = lines.join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
}

async function startServer(options: { project: string; runId: string }): Promise<{ baseUrl: string }> {
  const server = await startUiServer({ ...options, port: 0 });
  servers.push(server);
  return { baseUrl: server.url };
}

function buildSummaryUrl(baseUrl: string, projectName: string, runId: string): URL {
  return new URL(
    `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(runId)}/summary`,
    baseUrl,
  );
}

function buildOrchestratorEventsUrl(baseUrl: string, projectName: string, runId: string): URL {
  return new URL(
    `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(
      runId,
    )}/orchestrator/events`,
    baseUrl,
  );
}

function buildTaskEventsUrl(
  baseUrl: string,
  projectName: string,
  runId: string,
  taskId: string,
): URL {
  return new URL(
    `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(
      runId,
    )}/tasks/${encodeURIComponent(taskId)}/events`,
    baseUrl,
  );
}



// =============================================================================
// TESTS
// =============================================================================

describe("UI server", () => {
  it("serves summary and cursor-based event endpoints", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-300";
    const taskId = "task-1";
    const taskSlug = "bootstrap";

    writeRunState(root, projectName, runId, [taskId]);

    const logsDir = ensureRunLogsDir(root, projectName, runId);
    const orchestratorPath = path.join(logsDir, "orchestrator.jsonl");
    const orchestratorLines = [
      JSON.stringify({ type: "bootstrap.start", task_id: taskId }),
      JSON.stringify({ type: "bootstrap.finish", task_id: taskId }),
    ];
    writeJsonlFile(orchestratorPath, orchestratorLines);

    const taskEventsPath = ensureTaskEventsLog(root, projectName, runId, taskId, taskSlug);
    const taskLines = [
      JSON.stringify({ type: "bootstrap.start" }),
      JSON.stringify({ type: "bootstrap.finish" }),
      JSON.stringify({ type: "merge.begin" }),
    ];
    writeJsonlFile(taskEventsPath, taskLines);

    const { baseUrl } = await startServer({ project: projectName, runId });

    const summaryResponse = await fetch(buildSummaryUrl(baseUrl, projectName, runId));
    const summaryPayload = await summaryResponse.json();

    expect(summaryResponse.status).toBe(200);
    expect(summaryPayload.ok).toBe(true);
    expect(summaryPayload.result.runId).toBe(runId);
    expect(summaryPayload.result.status).toBe("running");
    expect(summaryPayload.result.tasks[0].id).toBe(taskId);

    const eventsUrl = buildOrchestratorEventsUrl(baseUrl, projectName, runId);
    eventsUrl.searchParams.set("cursor", "0");

    const eventsResponse = await fetch(eventsUrl);
    const eventsPayload = await eventsResponse.json();

    expect(eventsResponse.status).toBe(200);
    expect(eventsPayload.ok).toBe(true);
    expect(eventsPayload.result.lines).toEqual(orchestratorLines);

    const expectedNextCursor = Buffer.byteLength(orchestratorLines.join("\n") + "\n", "utf8");
    expect(eventsPayload.result.nextCursor).toBe(expectedNextCursor);

    const followUrl = buildOrchestratorEventsUrl(baseUrl, projectName, runId);
    followUrl.searchParams.set("cursor", String(eventsPayload.result.nextCursor));

    const followResponse = await fetch(followUrl);
    const followPayload = await followResponse.json();

    expect(followResponse.status).toBe(200);
    expect(followPayload.ok).toBe(true);
    expect(followPayload.result.lines).toEqual([]);
    expect(followPayload.result.nextCursor).toBe(expectedNextCursor);

    const taskUrl = buildTaskEventsUrl(baseUrl, projectName, runId, taskId);
    taskUrl.searchParams.set("cursor", "0");
    taskUrl.searchParams.set("typeGlob", "bootstrap.*");

    const taskResponse = await fetch(taskUrl);
    const taskPayload = await taskResponse.json();

    expect(taskResponse.status).toBe(200);
    expect(taskPayload.ok).toBe(true);
    expect(taskPayload.result.lines).toEqual(taskLines.slice(0, 2));
  });

  it("blocks traversal attempts on static and API paths", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-301";

    const { baseUrl } = await startServer({ project: projectName, runId });

    const staticUrl = new URL("/%2e%2e/%2e%2e/etc/passwd", baseUrl);
    const staticResponse = await fetch(staticUrl);

    expect([400, 404]).toContain(staticResponse.status);

    const apiUrl = new URL("/api/projects/%2e%2e/runs/%2e%2e/summary", baseUrl);
    const apiResponse = await fetch(apiUrl);
    const apiPayload = await apiResponse.json();

    expect(apiResponse.status).toBe(404);
    expect(apiPayload.ok).toBe(false);
    expect(apiPayload.error.code).toBe("not_found");
  });
});
