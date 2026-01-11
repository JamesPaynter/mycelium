import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExecResult } from "../docker/manager.js";
import { TaskError } from "./errors.js";
import { JsonlLogger } from "./logger.js";
import { runBootstrap } from "./bootstrap.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    fs.rmSync(file, { force: true });
  }
  tempFiles.length = 0;
});

describe("runBootstrap", () => {
  it("runs bootstrap commands sequentially and logs truncated output", async () => {
    const logPath = path.join(os.tmpdir(), `bootstrap-${Date.now()}.log`);
    tempFiles.push(logPath);

    const docker = new FakeDockerManager([
      { exitCode: 0, stdout: "A".repeat(12), stderr: "err" },
      { exitCode: 0, stdout: "ok", stderr: "" },
    ]);
    const logger = new JsonlLogger(logPath, { runId: "run-1", taskId: "task-1" });

    const result = await runBootstrap({
      commands: ["echo first", "echo second"],
      container: {} as any,
      docker,
      logger,
      workdir: "/workspace",
      truncateLength: 8,
    });

    logger.close();

    expect(result.status).toBe("success");
    expect(result.commands).toHaveLength(2);
    expect(docker.calls[0].command).toEqual(["sh", "-c", "echo first"]);
    expect(docker.calls[1].command).toEqual(["sh", "-c", "echo second"]);
    expect(docker.calls[0].opts.workdir).toBe("/workspace");

    const logLines = readJsonl(logPath);
    expect(logLines.map((l) => l.type)).toEqual([
      "bootstrap.start",
      "bootstrap.cmd.start",
      "bootstrap.cmd.complete",
      "bootstrap.cmd.start",
      "bootstrap.cmd.complete",
      "bootstrap.complete",
    ]);

    const firstComplete = logLines[2].payload as any;
    expect(firstComplete.stdout).toHaveLength(8);
    expect(firstComplete.stdout_truncated).toBe(true);
    expect(firstComplete.stderr_truncated).toBe(false);

    const secondComplete = logLines[4].payload as any;
    expect(secondComplete.stdout_truncated).toBe(false);
  });

  it("stops on failure and surfaces the error", async () => {
    const logPath = path.join(os.tmpdir(), `bootstrap-${Date.now()}.log`);
    tempFiles.push(logPath);

    const docker = new FakeDockerManager([
      { exitCode: 0, stdout: "ok", stderr: "" },
      { exitCode: 17, stdout: "oops", stderr: "bad" },
      { exitCode: 0, stdout: "should-not-run", stderr: "" },
    ]);
    const logger = new JsonlLogger(logPath, { runId: "run-2", taskId: "task-2" });

    await expect(
      runBootstrap({
        commands: ["true", "exit 17", "echo later"],
        container: {} as any,
        docker,
        logger,
        workdir: "/workspace",
      }),
    ).rejects.toBeInstanceOf(TaskError);

    logger.close();

    expect(docker.calls).toHaveLength(2);

    const logLines = readJsonl(logPath);
    expect(logLines.map((l) => l.type)).toEqual([
      "bootstrap.start",
      "bootstrap.cmd.start",
      "bootstrap.cmd.complete",
      "bootstrap.cmd.start",
      "bootstrap.cmd.fail",
      "bootstrap.failed",
    ]);

    const failedPayload = logLines[4].payload as any;
    expect(failedPayload.exit_code).toBe(17);
  });
});

class FakeDockerManager {
  readonly calls: Array<{ command: string[]; opts: any }> = [];

  constructor(private readonly results: ExecResult[]) {}

  async execInContainer(_container: any, command: string[], opts: any = {}): Promise<ExecResult> {
    const next = this.results[this.calls.length];
    if (!next) throw new Error("No more fake exec results");
    this.calls.push({ command, opts });
    return next;
  }
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
