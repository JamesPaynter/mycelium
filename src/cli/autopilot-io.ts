import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { AutopilotIo } from "../core/autopilot.js";
import type { PathsContext } from "../core/paths.js";
import { StateStore, summarizeRunState } from "../core/state-store.js";

// =============================================================================
// IO + STATUS
// =============================================================================

export class ConsoleAutopilotIo implements AutopilotIo {
  private rl = createInterface({ input, output });

  note(message: string): void {
    console.log(message);
  }

  async ask(question: string): Promise<string> {
    const prompt = question.trim().endsWith("?") ? question.trim() : `${question.trim()}?`;
    const answer = await this.rl.question(`${prompt} `);
    return answer.trim();
  }

  close(): void {
    this.rl.close();
  }
}

export function startRunProgressReporter(
  projectName: string,
  runId: string,
  paths: PathsContext,
  intervalMs = 5000,
): () => void {
  const store = new StateStore(projectName, runId, paths);
  let stopped = false;
  let running = false;

  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      try {
        if (!(await store.exists())) return;
        const summary = summarizeRunState(await store.load());
        console.log(
          `[run ${runId}] status=${summary.status}; complete=${summary.taskCounts.complete}/${summary.taskCounts.total}; running=${summary.taskCounts.running}; failed=${summary.taskCounts.failed}; review=${summary.humanReview.length}`,
        );
      } catch {
        // Avoid noisy status spam; rely on run completion output.
      } finally {
        running = false;
      }
    })();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
