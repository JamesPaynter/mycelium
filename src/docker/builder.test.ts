import path from "node:path";

import { describe, expect, it } from "vitest";

import { UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

import { buildWorkerImageFromTemplate } from "./builder.js";

describe("buildWorkerImageFromTemplate", () => {
  it("wraps missing Dockerfile errors with a user-facing hint", async () => {
    const missingDockerfile = path.join(
      process.cwd(),
      "missing-dockerfile",
      `Dockerfile-${Date.now()}`,
    );

    const result = await buildWorkerImageFromTemplate({
      tag: "worker:latest",
      dockerfile: missingDockerfile,
      context: process.cwd(),
    }).catch((err) => err);

    expect(result).toBeInstanceOf(UserFacingError);

    const userError = result as UserFacingError;
    expect(userError.code).toBe(USER_FACING_ERROR_CODES.docker);
    expect(userError.message).toContain("Dockerfile");
    expect(userError.hint).toContain("docker.dockerfile");
  });
});
