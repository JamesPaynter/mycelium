import fs from "node:fs";
import path from "node:path";
import fse from "fs-extra";

export type JsonObject = Record<string, unknown>;

export class JsonlLogger {
  private stream: fs.WriteStream;

  constructor(public readonly filePath: string) {
    fse.ensureDirSync(path.dirname(filePath));
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  log(event: JsonObject): void {
    this.stream.write(JSON.stringify(event) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

export function eventWithTs(event: JsonObject): JsonObject {
  return {
    ts: new Date().toISOString(),
    ...event
  };
}
