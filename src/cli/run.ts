import type { ProjectConfig } from "../core/config.js";
import { runProject, type RunOptions } from "../core/executor.js";

export async function runCommand(projectName: string, config: ProjectConfig, opts: RunOptions): Promise<void> {
  const res = await runProject(projectName, config, opts);
  console.log(`Run ${res.runId} finished with status: ${res.state.status}`);
}
