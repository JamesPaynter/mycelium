import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readJsonlFromCursor } from "../core/log-query.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-query-tail-"));
  tempDirs.push(dir);
  return dir;
}

function writeJsonlFile(
  filePath: string,
  lines: string[],
  opts: { trailingNewline?: boolean } = {},
): void {
  const trailingNewline = opts.trailingNewline ?? true;
  const content = lines.join("\n") + (trailingNewline ? "\n" : "");
  fs.writeFileSync(filePath, content, "utf8");
}

function appendText(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, "utf8");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});



// =============================================================================
// CURSOR READS
// =============================================================================

describe("readJsonlFromCursor", () => {
  it("reads new lines and advances the cursor", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "events.jsonl");

    const firstBatch = [
      JSON.stringify({ type: "bootstrap.start", task_id: "task-1" }),
      JSON.stringify({ type: "bootstrap.finish", task_id: "task-1" }),
    ];
    writeJsonlFile(logPath, firstBatch);

    const initial = await readJsonlFromCursor(logPath, 0, {});

    expect(initial.lines).toEqual(firstBatch);
    expect(initial.cursor).toBe(0);
    expect(initial.nextCursor).toBe(byteLength(firstBatch.join("\n") + "\n"));
    expect(initial.truncated).toBe(false);

    const appended = JSON.stringify({ type: "bootstrap.extra", task_id: "task-1" });
    appendText(logPath, `${appended}\n`);

    const next = await readJsonlFromCursor(logPath, initial.nextCursor, {});

    expect(next.lines).toEqual([appended]);
    expect(next.cursor).toBe(initial.nextCursor);
    expect(next.nextCursor).toBe(byteLength(firstBatch.join("\n") + "\n" + appended + "\n"));
    expect(next.truncated).toBe(false);
  });

  it("truncates by maxBytes and resumes cleanly", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "events.jsonl");

    const lines = ["alpha", "beta", "charlie"];
    writeJsonlFile(logPath, lines);

    const first = await readJsonlFromCursor(logPath, 0, {}, { maxBytes: 8 });
    expect(first.lines).toEqual(["alpha"]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe(byteLength("alpha\n"));

    const second = await readJsonlFromCursor(logPath, first.nextCursor, {}, { maxBytes: 8 });
    expect(second.lines).toEqual(["beta"]);
    expect(second.truncated).toBe(true);
    expect(second.nextCursor).toBe(byteLength("alpha\n") + byteLength("beta\n"));

    const third = await readJsonlFromCursor(logPath, second.nextCursor, {}, { maxBytes: 8 });
    expect(third.lines).toEqual(["charlie"]);
    expect(third.truncated).toBe(false);
    expect(third.nextCursor).toBe(byteLength(lines.join("\n") + "\n"));
  });

  it("does not advance past a partial last line", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "events.jsonl");

    writeJsonlFile(logPath, ["first", "second"], { trailingNewline: false });

    const initial = await readJsonlFromCursor(logPath, 0, {});
    expect(initial.lines).toEqual(["first"]);
    expect(initial.nextCursor).toBe(byteLength("first\n"));
    expect(initial.truncated).toBe(false);

    appendText(logPath, "\n");

    const next = await readJsonlFromCursor(logPath, initial.nextCursor, {});
    expect(next.lines).toEqual(["second"]);
    expect(next.nextCursor).toBe(byteLength("first\nsecond\n"));
  });

  it("applies type glob filters", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "events.jsonl");

    const lines = [
      JSON.stringify({ type: "bootstrap.start", task_id: "task-1" }),
      JSON.stringify({ type: "run.step", task_id: "task-1" }),
      JSON.stringify({ type: "bootstrap.finish", task_id: "task-2" }),
    ];
    writeJsonlFile(logPath, lines);

    const result = await readJsonlFromCursor(logPath, 0, { typeGlob: "bootstrap.*" });

    expect(result.lines).toEqual([lines[0], lines[2]]);
  });
});
