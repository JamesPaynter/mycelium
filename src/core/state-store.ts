import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import fse from "fs-extra";

import { runStatePath, runStateTempPath } from "./paths.js";
import { RunStateSchema, resetRunningTasks, type RunState } from "./state.js";
import { isoNow } from "./utils.js";

export class StateStore {
  constructor(
    public readonly projectName: string,
    public readonly runId: string,
    private readonly statePathValue = runStatePath(projectName, runId),
  ) {}

  get statePath(): string {
    return this.statePathValue;
  }

  async exists(): Promise<boolean> {
    return fse.pathExists(this.statePathValue);
  }

  async load(): Promise<RunState> {
    return loadRunState(this.statePathValue);
  }

  async save(state: RunState): Promise<void> {
    await saveRunState(this.statePathValue, state, this.tempPath());
  }

  async loadAndRecover(reason?: string): Promise<RunState> {
    const state = await this.load();
    resetRunningTasks(state, reason);
    await this.save(state);
    return state;
  }

  private tempPath(): string {
    const tempBase = runStateTempPath(this.projectName, this.runId);
    const tempName = path.basename(tempBase);
    return path.join(path.dirname(this.statePathValue), `${tempName}.${randomUUID()}`);
  }
}

export async function loadRunState(statePath: string): Promise<RunState> {
  const raw = await fse.readFile(statePath, "utf8");
  const parsed = RunStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid run state at ${statePath}: ${parsed.error.toString()}`);
  }

  return parsed.data;
}

export async function saveRunState(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const parsed = RunStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`Cannot save run state: ${parsed.error.toString()}`);
  }

  const normalized: RunState = { ...parsed.data, updated_at: isoNow() };
  Object.assign(state, normalized);

  await writeStateFile(statePath, normalized, tempPath);
}

export async function recoverRunState(
  statePath: string,
  reason?: string,
  tempPath?: string,
): Promise<RunState> {
  const state = await loadRunState(statePath);
  resetRunningTasks(state, reason);
  await saveRunState(statePath, state, tempPath);
  return state;
}

async function writeStateFile(
  statePath: string,
  state: RunState,
  tempPath?: string,
): Promise<void> {
  const dir = path.dirname(statePath);
  await fse.ensureDir(dir);

  const tmpPath = tempPath ?? `${statePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "w");

  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fse.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}
