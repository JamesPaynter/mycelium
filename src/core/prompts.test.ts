import { describe, expect, it } from "vitest";

import { renderPromptTemplate } from "./prompts.js";

const plannerContext = {
  project_name: "Sample Project",
  repo_path: "/workspace/sample",
  resources: "- **app**: main application\n  - Paths: src/app.ts",
  doctor_command: "npm test",
  implementation_plan: "1. Do a thing\n2. Do another thing",
  codebase_tree: "src/app.ts\nsrc/index.ts",
};

describe("renderPromptTemplate", () => {
  it("renders the planner template with provided values", async () => {
    const prompt = await renderPromptTemplate("planner", plannerContext);

    expect(prompt).toContain("Sample Project");
    expect(prompt).toContain("/workspace/sample");
    expect(prompt).toContain("main application");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("implementation plan");
    expect(prompt).not.toMatch(/\{\{.+\}\}/);
  });

  it("throws when a required placeholder is missing", async () => {
    const incomplete = { ...plannerContext };
    // @ts-expect-error intentional missing placeholder for test coverage
    delete incomplete.doctor_command;

    await expect(renderPromptTemplate("planner", incomplete)).rejects.toThrow();
  });

  it("renders validator templates", async () => {
    const testValidator = await renderPromptTemplate("test-validator", {
      project_name: "Sample Project",
      repo_path: "/workspace/sample",
      task_id: "001",
      task_name: "add-tests",
      task_spec: "Add unit tests for sample feature",
      changed_tests: "tests/sample.test.ts",
      tested_code: "src/sample.ts",
      diff_summary: "Added new assertions",
      test_output: "All tests passed",
    });

    expect(testValidator).toContain("test validation agent");
    expect(testValidator).toContain("001");

    const doctorValidator = await renderPromptTemplate("doctor-validator", {
      project_name: "Sample Project",
      repo_path: "/workspace/sample",
      doctor_command: "npm test",
      recent_doctor_runs: "Attempt 1: PASS",
      recent_changes: "src/sample.ts: added validation",
      doctor_expectations: "Should catch regressions in validation layer",
    });

    expect(doctorValidator).toContain("doctor validation agent");
    expect(doctorValidator).toContain("Attempt 1: PASS");
  });
});
