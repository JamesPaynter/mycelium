import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { describe, expect, it } from "vitest";

import { writeTasksToDirectory } from "./task-writer.js";
import type { TaskWithSpec } from "./task-manifest.js";

function tmpDir(prefix: string): Promise<string> {
  return fse.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("writeTasksToDirectory", () => {
  it("writes normalized manifests, specs, and plan index", async () => {
    const targetDir = await tmpDir("plan-writer-");

    const tasks: TaskWithSpec[] = [
      {
        id: "001",
        name: "sample-task",
        description: "Sample task",
        estimated_minutes: 20,
        dependencies: ["003", "002", "002"],
        locks: { reads: ["backend"], writes: [] },
        files: { reads: ["src/a.ts"], writes: ["src/a.ts", "src/a.ts"] },
        affected_tests: ["tests/a.test.ts", "tests/a.test.ts"],
        test_paths: ["tests/a.test.ts", "tests/a.test.ts"],
        tdd_mode: "strict",
        verify: { doctor: "npm test", fast: "npm test -- foo" },
        spec: "Do the thing\n\n- Step one",
      },
    ];

    const result = await writeTasksToDirectory({
      tasks,
      outputDir: targetDir,
      project: "demo",
      inputPath: "/repo/docs/plan.md",
    });

    const manifestPath = path.join(targetDir, "001-sample-task", "manifest.json");
    const manifest = await fse.readJson(manifestPath);

    expect(manifest.id).toBe("001");
    expect(manifest.dependencies).toEqual(["002", "003"]);
    expect(manifest.files).toEqual({
      reads: ["src/a.ts"],
      writes: ["src/a.ts"],
    });
    expect(manifest.affected_tests).toEqual(["tests/a.test.ts"]);
    expect(manifest.test_paths).toEqual(["tests/a.test.ts"]);
    expect(manifest.tdd_mode).toBe("strict");

    const specPath = path.join(targetDir, "001-sample-task", "spec.md");
    const spec = await fse.readFile(specPath, "utf8");
    expect(spec.endsWith("\n")).toBe(true);
    expect(spec.trim()).toContain("Do the thing");

    const planIndex = await fse.readJson(result.planIndexPath);
    expect(planIndex.task_count).toBe(1);
    expect(planIndex.tasks?.[0]?.dir).toBe("001-sample-task");
    expect(planIndex.output_dir).toBe(path.resolve(targetDir));

    await fse.remove(targetDir);
  });
});
