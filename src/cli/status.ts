import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../core/config.js";
import { runStateDir, runStatePath } from "../core/paths.js";
import { loadRunState } from "../core/state.js";

export async function statusCommand(projectName: string, _config: ProjectConfig, opts: { runId?: string }): Promise<void> {
  const runId = opts.runId ?? findLatestRunId(projectName);
  if (!runId) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  const statePath = runStatePath(projectName, runId);
  const state = await loadRunState(statePath);

  console.log(`Run: ${state.run_id}`);
  console.log(`Status: ${state.status}`);
  console.log(`Started: ${state.started_at}`);
  console.log(`Updated: ${state.updated_at}`);
  console.log("");

  if (state.batches.length > 0) {
    console.log("Batches:");
    for (const b of state.batches) {
      console.log(`  [${b.batch_id}] ${b.status}  (${b.tasks.length} tasks)`);
    }
    console.log("");
  }

  console.log("Tasks:");
  const ids = Object.keys(state.tasks).sort();
  for (const id of ids) {
    const t = state.tasks[id];
    const branch = t.branch ? `  branch=${t.branch}` : "";
    console.log(`  [${id}] ${t.status}${branch}`);
  }
}

function findLatestRunId(projectName: string): string | null {
  const dir = runStateDir(projectName);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (files.length === 0) return null;

  const withMtime = files
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const latest = withMtime[0].f;
  return latest.replace(/^run-/, "").replace(/\.json$/, "");
}
