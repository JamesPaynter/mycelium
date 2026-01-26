import fs from "node:fs";
import path from "node:path";

export type JsonlFilter = {
  taskId?: string;
  typeGlob?: string;
};

export type LogSearchResult = {
  filePath: string;
  lineNumber: number;
  line: string;
};

export type JsonlCursorReadResult = {
  lines: string[];
  cursor: number;
  nextCursor: number;
  truncated: boolean;
};

const DEFAULT_JSONL_CURSOR_MAX_BYTES = 512 * 1024;

// =============================================================================
// JSONL QUERIES
// =============================================================================

export function readJsonlFile(filePath: string, filter: JsonlFilter = {}): string[] {
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return filterJsonlLines(lines, filter);
}

export function filterJsonlLines(lines: string[], filter: JsonlFilter = {}): string[] {
  if (!filter.taskId && !filter.typeGlob) {
    return lines;
  }

  const typeMatcher = filter.typeGlob ? globToRegExp(filter.typeGlob) : null;

  return lines.filter((line) => {
    const parsed = safeParseJson(line);
    if (!parsed) {
      return false;
    }

    const taskId = extractTaskId(parsed);
    if (filter.taskId && taskId !== filter.taskId) {
      return false;
    }

    if (typeMatcher) {
      const type = extractType(parsed);
      return type ? typeMatcher.test(type) : false;
    }

    return true;
  });
}

export async function readJsonlFromCursor(
  filePath: string,
  cursor: number,
  filter: JsonlFilter = {},
  opts: { maxBytes?: number } = {},
): Promise<JsonlCursorReadResult> {
  if (!fs.existsSync(filePath)) {
    return { lines: [], cursor, nextCursor: cursor, truncated: false };
  }

  const fileSize = fs.statSync(filePath).size;
  const normalizedCursor = Math.max(0, cursor);
  let effectiveCursor = normalizedCursor;

  if (fileSize < effectiveCursor) {
    effectiveCursor = 0;
  }

  if (fileSize <= effectiveCursor) {
    return {
      lines: [],
      cursor: effectiveCursor,
      nextCursor: effectiveCursor,
      truncated: false,
    };
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_JSONL_CURSOR_MAX_BYTES;
  if (maxBytes <= 0) {
    return {
      lines: [],
      cursor: effectiveCursor,
      nextCursor: effectiveCursor,
      truncated: fileSize > effectiveCursor,
    };
  }

  const remainingBytes = fileSize - effectiveCursor;
  const bytesToRead = Math.min(remainingBytes, maxBytes);
  const end = effectiveCursor + bytesToRead - 1;
  const buffer = await readStreamRange(filePath, effectiveCursor, end);

  const lastNewlineIndex = buffer.lastIndexOf(0x0a);
  let nextCursor = effectiveCursor;
  let lines: string[] = [];

  if (lastNewlineIndex >= 0) {
    const completeBuffer = buffer.slice(0, lastNewlineIndex + 1);
    nextCursor = effectiveCursor + completeBuffer.length;
    const rawLines = completeBuffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    lines = filterJsonlLines(rawLines, filter);
  }

  const truncated = remainingBytes > maxBytes;
  return { lines, cursor: effectiveCursor, nextCursor, truncated };
}

export function followJsonlFile(
  filePath: string,
  filter: JsonlFilter,
  onLines: (lines: string[]) => void,
  opts: { pollIntervalMs?: number } = {},
): () => void {
  let offset = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const pollMs = opts.pollIntervalMs ?? 1000;

  const readNew = (): void => {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size < offset) {
      offset = 0;
    }
    if (stat.size === offset) {
      return;
    }

    const stream = fs.createReadStream(filePath, { start: offset, end: stat.size - 1 });
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    stream.on("end", () => {
      offset = stat.size;
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const filtered = filterJsonlLines(lines, filter);
      if (filtered.length > 0) {
        onLines(filtered);
      }
    });
    stream.on("error", () => {
      offset = stat.size;
    });
  };

  const timer = setInterval(readNew, pollMs);
  return () => clearInterval(timer);
}

// =============================================================================
// TASK LOG PATHS
// =============================================================================

export function findTaskLogDir(runLogsDir: string, taskId: string): string | null {
  const tasksDir = path.join(runLogsDir, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return null;
  }

  const match = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith(`${taskId}-`));

  return match ? path.join(tasksDir, match.name) : null;
}

export function taskEventsLogPathForId(runLogsDir: string, taskId: string): string | null {
  const taskDir = findTaskLogDir(runLogsDir, taskId);
  if (!taskDir) {
    return null;
  }

  const events = path.join(taskDir, "events.jsonl");
  return fs.existsSync(events) ? events : null;
}

// =============================================================================
// LOG SEARCH
// =============================================================================

export function searchLogs(
  baseDir: string,
  pattern: string,
  opts: { taskId?: string } = {},
): LogSearchResult[] {
  const searchRoot = opts.taskId ? findTaskLogDir(baseDir, opts.taskId) : baseDir;
  if (!searchRoot || !fs.existsSync(searchRoot)) {
    return [];
  }

  const files = listFiles(searchRoot);
  const matches: LogSearchResult[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (line && line.includes(pattern)) {
        matches.push({ filePath: file, lineNumber: idx + 1, line });
      }
    });
  }

  return matches;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function readStreamRange(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filePath, { start, end });

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", (error) => reject(error));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function extractTaskId(event: Record<string, unknown>): string | undefined {
  if (typeof event.task_id === "string") {
    return event.task_id;
  }
  if (typeof (event as { taskId?: unknown }).taskId === "string") {
    return (event as { taskId: string }).taskId;
  }
  return undefined;
}

function extractType(event: Record<string, unknown>): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}
