import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createUiRouter } from "../ui/router.js";

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const tempDirs: string[] = [];
const servers: http.Server[] = [];

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

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-router-task-"));
  tempDirs.push(dir);
  return dir;
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

function appendJsonlLine(filePath: string, line: string): void {
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
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

describe("UI task events API", () => {
  it("returns filtered events and advances the cursor", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-200";
    const taskId = "task-1";
    const taskSlug = "bootstrap";
    const logPath = ensureTaskEventsLog(root, projectName, runId, taskId, taskSlug);

    const lines = [
      JSON.stringify({ type: "bootstrap.start" }),
      JSON.stringify({ type: "bootstrap.finish" }),
      JSON.stringify({ type: "merge.begin" }),
    ];
    writeJsonlFile(logPath, lines);

    const router = createUiRouter({
      projectName,
      runId,
      staticRoot: path.join(root, "ui-static"),
    });
    const { baseUrl } = await startServer(router);

    const requestUrl = buildTaskEventsUrl(baseUrl, projectName, runId, taskId);
    requestUrl.searchParams.set("cursor", "0");
    requestUrl.searchParams.set("typeGlob", "bootstrap.*");

    const response = await fetch(requestUrl);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.result.file).toBe(
      path.posix.join("tasks", `${taskId}-${taskSlug}`, "events.jsonl"),
    );
    expect(payload.result.lines).toEqual(lines.slice(0, 2));
    expect(payload.result.cursor).toBe(0);
    expect(payload.result.truncated).toBe(false);

    const expectedNextCursor = Buffer.byteLength(lines.join("\n") + "\n", "utf8");
    expect(payload.result.nextCursor).toBe(expectedNextCursor);

    const appended = JSON.stringify({ type: "bootstrap.extra" });
    appendJsonlLine(logPath, appended);

    const followUrl = buildTaskEventsUrl(baseUrl, projectName, runId, taskId);
    followUrl.searchParams.set("cursor", String(payload.result.nextCursor));
    followUrl.searchParams.set("typeGlob", "bootstrap.*");

    const followResponse = await fetch(followUrl);
    const followPayload = await followResponse.json();

    expect(followResponse.status).toBe(200);
    expect(followPayload.result.lines).toEqual([appended]);
    expect(followPayload.result.cursor).toBe(payload.result.nextCursor);
    expect(followPayload.result.truncated).toBe(false);
    expect(followPayload.result.nextCursor).toBe(
      expectedNextCursor + Buffer.byteLength(`${appended}\n`, "utf8"),
    );
  });

  it("rejects invalid cursor values", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-201";
    const taskId = "task-2";
    const taskSlug = "install";
    const logPath = ensureTaskEventsLog(root, projectName, runId, taskId, taskSlug);
    writeJsonlFile(logPath, [JSON.stringify({ type: "bootstrap.start" })]);

    const router = createUiRouter({
      projectName,
      runId,
      staticRoot: path.join(root, "ui-static"),
    });
    const { baseUrl } = await startServer(router);

    const requestUrl = buildTaskEventsUrl(baseUrl, projectName, runId, taskId);
    requestUrl.searchParams.set("cursor", "not-a-number");

    const response = await fetch(requestUrl);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("bad_request");
  });

  it("returns not_found when task logs are missing", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-202";
    const taskId = "task-3";

    ensureRunLogsDir(root, projectName, runId);

    const router = createUiRouter({
      projectName,
      runId,
      staticRoot: path.join(root, "ui-static"),
    });
    const { baseUrl } = await startServer(router);

    const requestUrl = buildTaskEventsUrl(baseUrl, projectName, runId, taskId);
    requestUrl.searchParams.set("cursor", "0");

    const response = await fetch(requestUrl);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("not_found");
  });
});
