import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

type InsertableEvent = {
  run_id: string;
  source: string;
  line_no: number;
  ts: string;
  type: string;
  task_id: string | null;
  payload_json: string | null;
  raw: string;
};

export type LogIndexQuery = {
  taskId?: string;
  typeGlob?: string;
  search?: string;
};

export type IndexedEvent = {
  ts: string;
  type: string;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  raw: string;
  source: string;
  lineNumber: number;
};

export function logIndexPath(runLogsDir: string): string {
  return path.join(runLogsDir, "logs.sqlite");
}

export class LogIndex {
  private closed = false;

  private constructor(private readonly db: Database.Database, private readonly runId: string) {}

  static open(runId: string, runLogsDir: string, dbPath = logIndexPath(runLogsDir)): LogIndex {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    const index = new LogIndex(db, runId);
    index.ensureSchema();
    return index;
  }

  ingestRunLogs(runLogsDir: string): number {
    const files = listJsonlFiles(runLogsDir);
    let inserted = 0;

    for (const file of files) {
      const source = path.relative(runLogsDir, file);
      inserted += this.ingestJsonlFile(file, source);
    }

    return inserted;
  }

  queryEvents(query: LogIndexQuery = {}): IndexedEvent[] {
    const { sql, params } = buildQuery(this.runId, query);
    const rows = this.db.prepare(sql).all(...params) as {
      ts: string;
      type: string;
      task_id: string | null;
      payload_json: string | null;
      raw: string;
      source: string;
      line_no: number;
    }[];

    return rows.map((row) => ({
      ts: row.ts,
      type: row.type,
      taskId: row.task_id,
      payload: parsePayload(row.payload_json),
      raw: row.raw,
      source: row.source,
      lineNumber: row.line_no,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private ensureSchema(): void {
    this.db.pragma("case_sensitive_like = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        line_no INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        task_id TEXT,
        payload_json TEXT,
        raw TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_source_line ON events (run_id, source, line_no);
      CREATE INDEX IF NOT EXISTS idx_events_run_type ON events (run_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_run_task ON events (run_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events (run_id, ts);
    `);
  }

  private ingestJsonlFile(filePath: string, source: string): number {
    if (!fs.existsSync(filePath)) return 0;

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const events: InsertableEvent[] = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!line) continue;
      const parsed = parseEventLine(line, idx + 1, this.runId, source);
      if (parsed) {
        events.push(parsed);
      }
    }

    if (events.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (run_id, source, line_no, ts, type, task_id, payload_json, raw)
      VALUES (@run_id, @source, @line_no, @ts, @type, @task_id, @payload_json, @raw)
    `);

    let inserted = 0;
    const tx = this.db.transaction((rows: InsertableEvent[]) => {
      for (const row of rows) {
        const res = insert.run(row);
        inserted += res.changes;
      }
    });
    tx(events);

    return inserted;
  }
}

function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function parseEventLine(
  line: string,
  lineNumber: number,
  runId: string,
  source: string,
): InsertableEvent | null {
  const parsed = safeParseJson(line);
  if (!parsed) return null;

  const ts = typeof parsed.ts === "string" ? parsed.ts : null;
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!ts || !type) return null;

  const taskId = extractTaskId(parsed);
  const payloadJson = extractPayload(parsed);

  return {
    run_id: runId,
    source,
    line_no: lineNumber,
    ts,
    type,
    task_id: taskId ?? null,
    payload_json: payloadJson,
    raw: line,
  };
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractTaskId(event: Record<string, unknown>): string | null {
  if (typeof event.task_id === "string") return event.task_id;
  if (typeof (event as { taskId?: unknown }).taskId === "string") {
    return (event as { taskId: string }).taskId;
  }
  return null;
}

function extractPayload(event: Record<string, unknown>): string | null {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function buildQuery(runId: string, query: LogIndexQuery): { sql: string; params: unknown[] } {
  const clauses = ["run_id = ?"];
  const params: unknown[] = [runId];

  if (query.taskId) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }

  if (query.typeGlob) {
    clauses.push("type LIKE ? ESCAPE '\\'");
    params.push(globToLike(query.typeGlob));
  }

  if (query.search) {
    clauses.push("raw LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.search)}%`);
  }

  const sql = `
    SELECT ts, type, task_id, payload_json, raw, source, line_no
    FROM events
    WHERE ${clauses.join(" AND ")}
    ORDER BY ts ASC, id ASC
  `;

  return { sql, params };
}

function globToLike(glob: string): string {
  const escaped = escapeLike(glob);
  return escaped.replace(/\*/g, "%");
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
