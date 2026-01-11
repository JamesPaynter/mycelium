import type Docker from "dockerode";

import type { DockerManager } from "../docker/manager.js";
import { TaskError } from "./errors.js";
import type { JsonlLogger } from "./logger.js";

// =============================================================================
// TYPES
// =============================================================================

export type BootstrapCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BootstrapResult = {
  status: "success" | "skipped";
  commands: BootstrapCommandResult[];
};

export type BootstrapOptions = {
  commands: string[];
  container: Docker.Container;
  docker: Pick<DockerManager, "execInContainer">;
  logger?: JsonlLogger;
  workdir?: string;
  truncateLength?: number;
};

// =============================================================================
// EXECUTION
// =============================================================================

const DEFAULT_WORKDIR = "/workspace";
const OUTPUT_PREVIEW_LIMIT = 4000;

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const commands = opts.commands.filter((cmd) => cmd.trim().length > 0);
  if (commands.length === 0) {
    opts.logger?.log({ type: "bootstrap.skip" });
    return { status: "skipped", commands: [] };
  }

  const workdir = opts.workdir ?? DEFAULT_WORKDIR;
  const truncateLength = opts.truncateLength ?? OUTPUT_PREVIEW_LIMIT;

  opts.logger?.log({
    type: "bootstrap.start",
    payload: { command_count: commands.length },
  });

  const executed: BootstrapCommandResult[] = [];

  for (const cmd of commands) {
    opts.logger?.log({ type: "bootstrap.cmd.start", payload: { cmd } });

    const result = await opts.docker.execInContainer(
      opts.container,
      ["sh", "-c", cmd],
      { workdir },
    );

    const record: BootstrapCommandResult = {
      command: cmd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    executed.push(record);

    const stdout = truncateOutput(result.stdout, truncateLength);
    const stderr = truncateOutput(result.stderr, truncateLength);

    opts.logger?.log({
      type: result.exitCode === 0 ? "bootstrap.cmd.complete" : "bootstrap.cmd.fail",
      payload: {
        cmd,
        exit_code: result.exitCode,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
      },
    });

    if (result.exitCode !== 0) {
      opts.logger?.log({
        type: "bootstrap.failed",
        payload: { cmd, exit_code: result.exitCode },
      });
      throw new TaskError(`Bootstrap command failed: "${cmd}" exited with ${result.exitCode}`);
    }
  }

  opts.logger?.log({ type: "bootstrap.complete" });
  return { status: "success", commands: executed };
}

// =============================================================================
// HELPERS
// =============================================================================

function truncateOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
