import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../core/config.js";
import { runLogsDir, runStateDir } from "../core/paths.js";

export async function logsCommand(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; taskId?: string; follow?: boolean; search?: string }
): Promise<void> {
  const runId = opts.runId ?? findLatestRunIdFromLogs(projectName);
  if (!runId) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  const base = runLogsDir(projectName, runId);
  let file: string;
  if (opts.taskId) {
    // Task logs live under logs/<project>/run-<id>/tasks/<taskId-*>/events.jsonl
    const tasksDir = path.join(base, "tasks");
    if (!fs.existsSync(tasksDir)) {
      console.log(`No task logs dir found: ${tasksDir}`);
      return;
    }
    const match = fs
      .readdirSync(tasksDir)
      .find((d) => d.startsWith(`${opts.taskId}-`));
    if (!match) {
      console.log(`No task log directory found for task ${opts.taskId}.`);
      return;
    }
    file = path.join(tasksDir, match, "events.jsonl");
  } else {
    file = path.join(base, "orchestrator.jsonl");
  }

  if (!fs.existsSync(file)) {
    console.log(`Log file not found: ${file}`);
    return;
  }

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);

  const filtered = opts.search ? lines.filter((l) => l.includes(opts.search!)) : lines;

  for (const l of filtered) {
    console.log(l);
  }

  if (opts.follow) {
    console.log(`\n--follow is not implemented in this MVP. Use:\n  tail -f ${file}\n`);
  }
}

function findLatestRunIdFromLogs(projectName: string): string | null {
  const dir = runStateDir(projectName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  const latest = files[files.length - 1];
  return latest.replace(/^run-/, "").replace(/\.json$/, "");
}
