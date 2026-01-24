import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import fse from "fs-extra";
import { z } from "zod";

import { taskLedgerPath } from "./paths.js";
import { TaskManifestSchema, normalizeTaskManifest } from "./task-manifest.js";
import { isoNow } from "./utils.js";


// =============================================================================
// TYPES
// =============================================================================

export type TaskLedgerEntry = {
  taskId: string;
  status: "complete" | "skipped" | "blocked" | "failed";
  fingerprint?: string;
  mergeCommit?: string;
  integrationDoctorPassed?: boolean;
  completedAt?: string;
  runId?: string;
  source?: "executor" | "import-run";
};

export type TaskLedger = {
  schemaVersion: 1;
  updatedAt: string;
  tasks: Record<string, TaskLedgerEntry>;
};


// =============================================================================
// SCHEMA
// =============================================================================

const TaskLedgerEntrySchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["complete", "skipped", "blocked", "failed"]),
    fingerprint: z.string().optional(),
    mergeCommit: z.string().optional(),
    integrationDoctorPassed: z.boolean().optional(),
    completedAt: z.string().optional(),
    runId: z.string().optional(),
    source: z.enum(["executor", "import-run"]).optional(),
  })
  .strict();

const TaskLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string(),
    tasks: z.record(TaskLedgerEntrySchema),
  })
  .strict();

const TASK_LEDGER_SCHEMA_VERSION = 1;


// =============================================================================
// PUBLIC API
// =============================================================================

export async function loadTaskLedger(projectName: string): Promise<TaskLedger | null> {
  const ledgerPath = taskLedgerPath(projectName);
  const raw = await fs.readFile(ledgerPath, "utf8").catch((error) => {
    if (isMissingFile(error)) return null;
    throw error;
  });

  if (!raw) {
    return null;
  }

  try {
    const parsed = TaskLedgerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveTaskLedger(projectName: string, ledger: TaskLedger): Promise<void> {
  const parsed = TaskLedgerSchema.safeParse(ledger);
  if (!parsed.success) {
    throw new Error(`Cannot save task ledger: ${parsed.error.toString()}`);
  }

  await writeJsonFileAtomic(taskLedgerPath(projectName), parsed.data);
}

export async function upsertLedgerEntry(
  projectName: string,
  entry: TaskLedgerEntry,
): Promise<TaskLedger> {
  const parsedEntry = TaskLedgerEntrySchema.safeParse(entry);
  if (!parsedEntry.success) {
    throw new Error(`Cannot upsert task ledger entry: ${parsedEntry.error.toString()}`);
  }

  const existingLedger = await loadTaskLedger(projectName);
  const tasks = {
    ...(existingLedger?.tasks ?? {}),
    [parsedEntry.data.taskId]: parsedEntry.data,
  };

  const ledger: TaskLedger = {
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    updatedAt: isoNow(),
    tasks,
  };

  await saveTaskLedger(projectName, ledger);
  return ledger;
}

export async function computeTaskFingerprint(options: {
  manifestPath: string;
  specPath: string;
}): Promise<string> {
  const manifestRaw = await fs.readFile(options.manifestPath, "utf8");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid task manifest JSON at ${options.manifestPath}: ${detail}`);
  }

  const parsedManifest = TaskManifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    throw new Error(
      `Invalid task manifest at ${options.manifestPath}: ${parsedManifest.error.toString()}`,
    );
  }

  const normalizedManifest = normalizeTaskManifest(parsedManifest.data);
  const canonicalManifest = stableStringify(normalizedManifest);

  const specRaw = await fs.readFile(options.specPath, "utf8");
  const normalizedSpec = normalizeSpecMarkdown(specRaw);

  const fingerprintInput = `${canonicalManifest}\n---\n${normalizedSpec}`;
  const digest = createHash("sha256").update(fingerprintInput).digest("hex");
  return `sha256:${digest}`;
}


// =============================================================================
// FINGERPRINTING
// =============================================================================

function normalizeSpecMarkdown(raw: string): string {
  const withLf = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return withLf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const sorted: Record<string, unknown> = {};

    for (const key of keys) {
      sorted[key] = sortJsonValue(record[key]);
    }

    return sorted;
  }

  return value;
}


// =============================================================================
// IO HELPERS
// =============================================================================

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fse.ensureDir(directoryPath);

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, "w");

  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fse.remove(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}
