import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { queryOrchestratorEvents, queryTaskEvents } from "../ui/queries/log-queries.js";

const ENV_VARS = ["MYCELIUM_HOME"] as const;
const originalEnv: Record<(typeof ENV_VARS)[number], string | undefined> = Object.fromEntries(
  ENV_VARS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>;

const tempDirs: string[] = [];

afterEach(() => {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-log-queries-"));
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

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// =============================================================================
// TESTS
// =============================================================================

describe("log query services", () => {
  it("returns filtered orchestrator events and advances the cursor", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-101";
    const logsDir = ensureRunLogsDir(root, projectName, runId);
    const logPath = path.join(logsDir, "orchestrator.jsonl");

    const lines = [
      JSON.stringify({ type: "bootstrap.start", task_id: "task-1" }),
      JSON.stringify({ type: "bootstrap.finish", task_id: "task-2" }),
      JSON.stringify({ type: "merge.begin", task_id: "task-1" }),
    ];
    writeJsonlFile(logPath, lines);

    const result = await queryOrchestratorEvents({
      projectName,
      runId,
      cursor: "0",
      maxBytes: null,
      typeGlob: "bootstrap.*",
      taskId: "task-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.file).toBe("orchestrator.jsonl");
    expect(result.result.lines).toEqual([lines[0]]);
    expect(result.result.cursor).toBe(0);
    expect(result.result.truncated).toBe(false);
    expect(result.result.nextCursor).toBe(byteLength(lines.join("\n") + "\n"));
  });

  it("returns filtered task events with normalized file paths", async () => {
    const root = makeTempDir();
    process.env.MYCELIUM_HOME = root;

    const projectName = "demo-project";
    const runId = "run-102";
    const taskId = "task-7";
    const taskSlug = "bootstrap";
    const logPath = ensureTaskEventsLog(root, projectName, runId, taskId, taskSlug);

    const lines = [
      JSON.stringify({ type: "bootstrap.start" }),
      JSON.stringify({ type: "bootstrap.finish" }),
      JSON.stringify({ type: "merge.begin" }),
    ];
    writeJsonlFile(logPath, lines);

    const result = await queryTaskEvents({
      projectName,
      runId,
      taskId,
      cursor: "0",
      maxBytes: null,
      typeGlob: "bootstrap.*",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.file).toBe(
      path.posix.join("tasks", `${taskId}-${taskSlug}`, "events.jsonl"),
    );
    expect(result.result.lines).toEqual(lines.slice(0, 2));
    expect(result.result.cursor).toBe(0);
    expect(result.result.truncated).toBe(false);
    expect(result.result.nextCursor).toBe(byteLength(lines.join("\n") + "\n"));
  });
});
