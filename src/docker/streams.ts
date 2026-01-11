import { PassThrough } from "node:stream";

import type Docker from "dockerode";

import { JsonlLogger, logJsonLineOrRaw } from "../core/logger.js";

export type StreamLineHandler = (line: string, stream: "stdout" | "stderr") => void;

export async function attachLineStream(
  container: Docker.Container,
  onLine: StreamLineHandler,
): Promise<() => void> {
  const raw = await container.attach({ stream: true, stdout: true, stderr: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const modem =
    (container as any).modem ??
    (raw as any).modem ??
    (container as any).docker?.modem ??
    (container as any).client?.modem;

  // demux the raw docker stream into stdout/stderr when possible
  if (modem && typeof modem.demuxStream === "function") {
    modem.demuxStream(raw, stdout, stderr);
  } else {
    raw.pipe(stdout);
  }

  const cleaners: Array<() => void> = [];

  cleaners.push(pipeLines(stdout, (l) => onLine(l, "stdout")));
  cleaners.push(pipeLines(stderr, (l) => onLine(l, "stderr")));

  return () => {
    for (const c of cleaners) c();
    if (typeof (raw as any).destroy === "function") {
      (raw as any).destroy();
    }
    stdout.destroy();
    stderr.destroy();
  };
}

export async function streamContainerLogs(
  container: Docker.Container,
  logger: JsonlLogger,
  opts: { fallbackType?: string } = {},
): Promise<() => void> {
  const fallbackType = opts.fallbackType ?? "task.log";
  return attachLineStream(container, (line, stream) =>
    logJsonLineOrRaw(logger, line, stream, fallbackType),
  );
}

function pipeLines(stream: PassThrough, onLine: (line: string) => void): () => void {
  let buf = "";
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trimEnd();
      if (trimmed.length > 0) onLine(trimmed);
    }
  };

  stream.on("data", onData);

  return () => {
    stream.off("data", onData);
  };
}
