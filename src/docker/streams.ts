import { PassThrough } from "node:stream";

import type Docker from "dockerode";

import { JsonlLogger, logJsonLineOrRaw } from "../core/logger.js";

export type StreamLineHandler = (line: string, stream: "stdout" | "stderr") => void;
export type LogStreamHandle = { detach: () => void; completed: Promise<void> };

export async function attachLineStream(
  container: Docker.Container,
  onLine: StreamLineHandler,
): Promise<LogStreamHandle> {
  const raw = await container.attach({ stream: true, stdout: true, stderr: true });
  return demuxDockerStream(raw as NodeJS.ReadableStream, container, onLine);
}

export async function streamContainerLogs(
  container: Docker.Container,
  logger: JsonlLogger,
  opts: { fallbackType?: string; includeHistory?: boolean; follow?: boolean } = {},
): Promise<LogStreamHandle> {
  const fallbackType = opts.fallbackType ?? "task.log";

  const onLine: StreamLineHandler = (line, stream) =>
    logJsonLineOrRaw(logger, line, stream, fallbackType);

  if (opts.includeHistory) {
    const raw = await fetchLogStream(container, opts.follow ?? true);
    return demuxDockerStream(raw as NodeJS.ReadableStream | Buffer, container, onLine);
  }

  return attachLineStream(container, onLine);
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

function demuxDockerStream(
  raw: NodeJS.ReadableStream | Buffer,
  container: Docker.Container,
  onLine: StreamLineHandler,
): LogStreamHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stream = toReadableStream(raw);

  const modem =
    (container as any).modem ??
    (stream as any).modem ??
    (container as any).docker?.modem ??
    (container as any).client?.modem;

  if (modem && typeof modem.demuxStream === "function") {
    modem.demuxStream(stream, stdout, stderr);
  } else {
    stream.pipe(stdout);
  }

  const cleaners: Array<() => void> = [];
  cleaners.push(pipeLines(stdout, (l) => onLine(l, "stdout")));
  cleaners.push(pipeLines(stderr, (l) => onLine(l, "stderr")));

  const completed = Promise.all([waitForStreamEnd(stdout), waitForStreamEnd(stderr)]).then(
    () => undefined,
  );

  return {
    detach: () => {
      for (const c of cleaners) c();
      destroyStream(stream);
      stdout.destroy();
      stderr.destroy();
    },
    completed,
  };
}

function toReadableStream(raw: NodeJS.ReadableStream | Buffer): NodeJS.ReadableStream {
  if (Buffer.isBuffer(raw)) {
    const stream = new PassThrough();
    stream.end(raw);
    return stream;
  }
  return raw;
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  if (typeof (stream as any).destroy === "function") {
    (stream as any).destroy();
  }
}

function fetchLogStream(
  container: Docker.Container,
  follow: boolean,
): Promise<NodeJS.ReadableStream | Buffer> {
  return new Promise((resolve, reject) => {
    (container as any).logs(
      { stdout: true, stderr: true, follow, tail: "all" },
      (err: unknown, stream: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream as NodeJS.ReadableStream | Buffer);
      },
    );
  });
}

function waitForStreamEnd(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };

    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      resolve();
    };

    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
  });
}
