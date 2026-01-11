import fs from "node:fs";
import path from "node:path";
import fse from "fs-extra";

import type { ProjectConfig } from "../core/config.js";
import { runLogsDir, runStateDir, runWorkspaceDir } from "../core/paths.js";
import { dockerClient } from "../docker/docker.js";

export async function cleanCommand(
  projectName: string,
  _config: ProjectConfig,
  opts: { runId?: string; keepLogs?: boolean }
): Promise<void> {
  const runId = opts.runId ?? findLatestRunId(projectName);
  if (!runId) {
    console.log(`No runs found for project ${projectName}.`);
    return;
  }

  // Remove workspaces
  const wdir = runWorkspaceDir(projectName, runId);
  if (fs.existsSync(wdir)) {
    await fse.remove(wdir);
    console.log(`Removed workspaces: ${wdir}`);
  }

  if (!opts.keepLogs) {
    const ldir = runLogsDir(projectName, runId);
    if (fs.existsSync(ldir)) {
      await fse.remove(ldir);
      console.log(`Removed logs: ${ldir}`);
    }
  }

  // Remove containers with matching label
  const docker = dockerClient();
  const containers = await docker.listContainers({ all: true });
  const toRemove = containers.filter((c) => c.Labels?."task-orchestrator.project" === projectName && c.Labels?."task-orchestrator.run_id" === runId);
  for (const c of toRemove) {
    try {
      const container = docker.getContainer(c.Id);
      if (c.State === "running") {
        await container.stop({ t: 5 });
      }
      await container.remove({ force: true });
      console.log(`Removed container: ${c.Names?.[0] ?? c.Id}`);
    } catch {
      // ignore
    }
  }
}

function findLatestRunId(projectName: string): string | null {
  const dir = runStateDir(projectName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  const latest = files[files.length - 1];
  return latest.replace(/^run-/, "").replace(/\.json$/, "");
}
