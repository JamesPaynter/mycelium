import fs from "node:fs/promises";
import path from "node:path";

// =============================================================================
// PARAM PARSING
// =============================================================================

type OptionalNumberParseResult = { ok: true; value: number | null } | { ok: false };
export type CursorParam = number | "tail";

export function parseOptionalString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseOptionalNonNegativeInteger(value: string | null): OptionalNumberParseResult {
  if (value === null) {
    return { ok: true, value: null };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }

  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false };
  }

  return { ok: true, value: parsed };
}

export function parseOptionalPositiveInteger(value: string | null): OptionalNumberParseResult {
  const parsed = parseOptionalNonNegativeInteger(value);
  if (!parsed.ok) {
    return { ok: false };
  }

  if (parsed.value === null) {
    return parsed;
  }

  return parsed.value > 0 ? parsed : { ok: false };
}

export function parseCursorParam(
  value: string | null,
): { ok: true; value: CursorParam } | { ok: false } {
  if (value === null) {
    return { ok: true, value: 0 };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: 0 };
  }

  if (trimmed === "tail") {
    return { ok: true, value: "tail" };
  }

  const parsed = parseOptionalNonNegativeInteger(trimmed);
  if (!parsed.ok) {
    return { ok: false };
  }

  return { ok: true, value: parsed.value ?? 0 };
}

// =============================================================================
// FILE HELPERS
// =============================================================================

type JsonFileReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "not_found" | "too_large" };

export function normalizeLogPath(baseDir: string, filePath: string): string {
  const relativePath = path.relative(baseDir, filePath);
  return relativePath.split(path.sep).join("/");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
}

export async function readJsonFileWithLimit(
  filePath: string,
  maxBytes: number,
): Promise<JsonFileReadResult> {
  const stat = await fs.stat(filePath).catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!stat || !stat.isFile()) {
    return { ok: false, reason: "not_found" };
  }

  if (stat.size > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const raw = await fs.readFile(filePath, "utf8");
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
}

export async function findValidatorReportPath(
  runLogsDir: string,
  validator: string,
  taskId: string,
): Promise<string | null> {
  const validatorDir = path.join(runLogsDir, "validators", validator);
  const entries = await fs.readdir(validatorDir, { withFileTypes: true }).catch((err) => {
    if (isMissingFile(err)) return null;
    throw err;
  });

  if (!entries) {
    return null;
  }

  let latest: { path: string; mtimeMs: number } | null = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(`${taskId}-`)) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;

    const fullPath = path.join(validatorDir, entry.name);
    const stat = await fs.stat(fullPath).catch((err) => {
      if (isMissingFile(err)) return null;
      throw err;
    });

    if (!stat || !stat.isFile()) continue;
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { path: fullPath, mtimeMs: stat.mtimeMs };
    }
  }

  return latest ? latest.path : null;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}
