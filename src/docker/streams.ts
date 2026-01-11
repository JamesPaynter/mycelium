import type Docker from "dockerode";
import { PassThrough } from "node:stream";

export type StreamLineHandler = (line: string, stream: "stdout" | "stderr") => void;

export async function attachLineStream(container: Docker.Container, onLine: StreamLineHandler): Promise<() => void> {
  const raw = await container.attach({ stream: true, stdout: true, stderr: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // demux the raw docker stream into stdout/stderr
  (container as any).modem.demuxStream(raw, stdout, stderr);

  const cleaners: Array<() => void> = [];

  cleaners.push(pipeLines(stdout, (l) => onLine(l, "stdout")));
  cleaners.push(pipeLines(stderr, (l) => onLine(l, "stderr")));

  return () => {
    for (const c of cleaners) c();
    raw.destroy();
    stdout.destroy();
    stderr.destroy();
  };
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
