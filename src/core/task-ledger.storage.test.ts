import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { createPathsContext, taskLedgerPath } from "./paths.js";
import { loadTaskLedger, saveTaskLedger, type TaskLedger } from "./task-ledger.js";
import {
  makeTemporaryDirectory,
  registerTaskLedgerTempCleanup,
} from "./task-ledger.test-helpers.js";

registerTaskLedgerTempCleanup();

describe("task ledger storage", () => {
  it("roundtrips ledger load and save", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    const paths = createPathsContext({ myceliumHome: temporaryHomeDirectory });

    const projectName = "demo-project";
    const ledger: TaskLedger = {
      schemaVersion: 1,
      updatedAt: "2024-03-01T00:00:00.000Z",
      tasks: {
        "210": {
          taskId: "210",
          status: "complete",
          fingerprint: "sha256:abc123",
          mergeCommit: "deadbeef",
          integrationDoctorPassed: true,
          completedAt: "2024-03-01T00:10:00.000Z",
          runId: "run-210",
          source: "executor",
        },
      },
    };

    await saveTaskLedger(projectName, ledger, paths);
    const loaded = await loadTaskLedger(projectName, paths);

    expect(loaded).toEqual(ledger);
    expect(fs.existsSync(taskLedgerPath(projectName, paths))).toBe(true);
  });
});
