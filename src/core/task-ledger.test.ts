import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { taskLedgerPath } from "./paths.js";
import { computeTaskFingerprint, loadTaskLedger, saveTaskLedger } from "./task-ledger.js";
import type { TaskLedger } from "./task-ledger.js";

const originalHome = process.env.MYCELIUM_HOME;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;

  if (originalHome === undefined) {
    delete process.env.MYCELIUM_HOME;
  } else {
    process.env.MYCELIUM_HOME = originalHome;
  }
});


// =============================================================================
// HELPERS
// =============================================================================

function makeTemporaryDirectory(prefix: string): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}


// =============================================================================
// TESTS
// =============================================================================

describe("task ledger fingerprint", () => {
  it("keeps fingerprints stable across manifest key ordering", async () => {
    const temporaryDirectory = makeTemporaryDirectory("task-ledger-fingerprint-");
    const manifestPathFirst = path.join(temporaryDirectory, "manifest-a.json");
    const manifestPathSecond = path.join(temporaryDirectory, "manifest-b.json");
    const specPathFirst = path.join(temporaryDirectory, "spec-a.md");
    const specPathSecond = path.join(temporaryDirectory, "spec-b.md");

    const manifestWithDefaultOrder = {
      id: "210",
      name: "Ledger Task",
      description: "Manifest ordering test",
      estimated_minutes: 30,
      dependencies: ["003", "001"],
      locks: { reads: ["db"], writes: [] },
      files: { reads: ["src/a.ts"], writes: ["src/b.ts"] },
      affected_tests: ["test/a.test.ts"],
      test_paths: ["test/a.test.ts"],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    const manifestWithReorderedKeys = {
      verify: { doctor: "npm test" },
      tdd_mode: "off",
      test_paths: ["test/a.test.ts"],
      affected_tests: ["test/a.test.ts"],
      files: { writes: ["src/b.ts"], reads: ["src/a.ts"] },
      locks: { writes: [], reads: ["db"] },
      dependencies: ["003", "001"],
      estimated_minutes: 30,
      description: "Manifest ordering test",
      name: "Ledger Task",
      id: "210",
    };

    await fse.writeFile(
      manifestPathFirst,
      JSON.stringify(manifestWithDefaultOrder, null, 2),
      "utf8",
    );
    await fse.writeFile(
      manifestPathSecond,
      JSON.stringify(manifestWithReorderedKeys, null, 2),
      "utf8",
    );

    const specWithUnixLineEndings = "Do the work.\n\n- Step one\n";
    const specWithWindowsLineEndings = "Do the work.\r\n\r\n- Step one\r\n";
    await fse.writeFile(specPathFirst, specWithUnixLineEndings, "utf8");
    await fse.writeFile(specPathSecond, specWithWindowsLineEndings, "utf8");

    const firstFingerprint = await computeTaskFingerprint({
      manifestPath: manifestPathFirst,
      specPath: specPathFirst,
    });
    const secondFingerprint = await computeTaskFingerprint({
      manifestPath: manifestPathSecond,
      specPath: specPathSecond,
    });

    expect(firstFingerprint).toBe(secondFingerprint);
  });

  it("changes fingerprint when spec content changes", async () => {
    const temporaryDirectory = makeTemporaryDirectory("task-ledger-fingerprint-change-");
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const specPathInitial = path.join(temporaryDirectory, "spec-a.md");
    const specPathUpdated = path.join(temporaryDirectory, "spec-b.md");

    const manifest = {
      id: "210",
      name: "Ledger Task",
      description: "Spec change test",
      estimated_minutes: 30,
      dependencies: [],
      locks: { reads: [], writes: [] },
      files: { reads: [], writes: [] },
      affected_tests: [],
      test_paths: [],
      tdd_mode: "off",
      verify: { doctor: "npm test" },
    };

    await fse.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fse.writeFile(specPathInitial, "Do the work.\n\n- Step one\n", "utf8");
    await fse.writeFile(specPathUpdated, "Do the work.\n\n- Step two\n", "utf8");

    const firstFingerprint = await computeTaskFingerprint({
      manifestPath,
      specPath: specPathInitial,
    });
    const secondFingerprint = await computeTaskFingerprint({
      manifestPath,
      specPath: specPathUpdated,
    });

    expect(firstFingerprint).not.toBe(secondFingerprint);
  });
});

describe("task ledger storage", () => {
  it("roundtrips ledger load and save", async () => {
    const temporaryHomeDirectory = makeTemporaryDirectory("task-ledger-home-");
    process.env.MYCELIUM_HOME = temporaryHomeDirectory;

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

    await saveTaskLedger(projectName, ledger);
    const loaded = await loadTaskLedger(projectName);

    expect(loaded).toEqual(ledger);
    expect(fs.existsSync(taskLedgerPath(projectName))).toBe(true);
  });
});
