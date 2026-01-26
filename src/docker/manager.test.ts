import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { JsonlLogger } from "../core/logger.js";
import { DockerManager } from "./manager.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    fs.rmSync(file, { force: true });
  }
  tempFiles.length = 0;
});

describe("DockerManager", () => {
  it("runs a container, streams logs, and cleans up on success", async () => {
    const logPath = path.join(os.tmpdir(), `docker-manager-${Date.now()}.log`);
    tempFiles.push(logPath);
    const logger = new JsonlLogger(logPath, { runId: "run-1", taskId: "task-1" });

    const container = new FakeContainer();
    const docker = { createContainer: async () => container } as any;
    const manager = new DockerManager({ docker, cleanupOnSuccess: true });

    const result = await manager.runContainer({
      spec: {
        name: "ct-1",
        image: "worker:latest",
        env: {},
        binds: [],
        workdir: "/workspace",
      },
      logger,
    });

    logger.close();

    const logLines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(result.exitCode).toBe(0);
    expect(result.containerId).toBe("container-123");
    expect(container.removed).toBe(true);

    expect(logLines[0].type).toBe("task.event");
    expect(logLines[0].payload.stream).toBe("stdout");
    expect(logLines[0].payload.payload.message).toBe("hi");

    expect(logLines[1].type).toBe("task.log");
    expect(logLines[1].payload.stream).toBe("stdout");
    expect(logLines[1].payload.raw).toBe("RAW LINE");
  });

  it("executes a command inside a container and captures output", async () => {
    const container = new ExecContainer(["STDOUT:first\n", "STDERR:oops\n", "STDOUT:last\n"], 17);
    const manager = new DockerManager({ docker: {} as any });

    const result = await manager.execInContainer(container as any, ["bash", "-c", "echo hi"], {
      env: { KEEP: "1", DROP: undefined },
      workdir: "/work",
      user: "node",
    });

    expect(container.execCalls).toHaveLength(1);
    const execOpts = container.execCalls[0];

    expect(execOpts.Cmd).toEqual(["bash", "-c", "echo hi"]);
    expect(execOpts.Env).toEqual(["KEEP=1"]);
    expect(execOpts.WorkingDir).toBe("/work");
    expect(execOpts.User).toBe("node");

    expect(result.exitCode).toBe(17);
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("last");
    expect(result.stderr).toContain("oops");
  });
});

class FakeModem {
  demuxStream(raw: PassThrough, stdout: PassThrough, stderr: PassThrough): void {
    raw.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.startsWith("STDERR:")) {
        stderr.write(text.replace(/^STDERR:/, ""));
      } else {
        stdout.write(text.replace(/^STDOUT:/, ""));
      }
    });
    raw.on("end", () => {
      stdout.end();
      stderr.end();
    });
  }
}

class FakeContainer {
  readonly modem = new FakeModem();
  removed = false;
  private readonly raw = new PassThrough();

  async attach(): Promise<PassThrough> {
    return this.raw;
  }

  async start(): Promise<void> {
    this.raw.write('{"type":"task.event","payload":{"message":"hi"}}\n');
    this.raw.write("RAW LINE\n");
    this.raw.end();
  }

  async wait(): Promise<{ StatusCode: number }> {
    return { StatusCode: 0 };
  }

  async inspect(): Promise<{ Id: string; Name: string }> {
    return { Id: "container-123", Name: "fake-container" };
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

class ExecContainer extends FakeContainer {
  readonly execCalls: any[] = [];

  constructor(
    private readonly chunks: string[],
    private readonly exitCode: number,
  ) {
    super();
  }

  async exec(opts: any): Promise<FakeExec> {
    this.execCalls.push(opts);
    return new FakeExec(this.chunks, this.exitCode);
  }
}

class FakeExec {
  constructor(
    private readonly chunks: string[],
    private readonly exitCode: number,
  ) {}

  async start(): Promise<PassThrough> {
    const stream = new PassThrough();
    queueMicrotask(() => {
      for (const chunk of this.chunks) {
        stream.write(chunk);
      }
      stream.end();
    });
    return stream;
  }

  async inspect(): Promise<{ ExitCode: number }> {
    return { ExitCode: this.exitCode };
  }
}
