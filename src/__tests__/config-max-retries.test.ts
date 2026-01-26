import { describe, expect, it } from "vitest";

import { ProjectConfigSchema } from "../core/config.js";

describe("ProjectConfigSchema max_retries", () => {
  it("accepts max_retries=0 for unlimited retries", () => {
    const config = ProjectConfigSchema.parse({
      repo_path: "/tmp/repo",
      doctor: "npm test",
      max_retries: 0,
      resources: [{ name: "repo", paths: ["**/*"] }],
      planner: { model: "mock" },
      worker: { model: "mock", max_retries: 0 },
    });

    expect(config.max_retries).toBe(0);
    expect(config.worker.max_retries).toBe(0);
  });
});
