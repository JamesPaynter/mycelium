import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserFacingError, USER_FACING_ERROR_CODES } from "../core/errors.js";

import { buildWorkerImage } from "./image.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const execaMock = vi.mocked(execa);

describe("buildWorkerImage", () => {
  afterEach(() => {
    execaMock.mockReset();
  });

  it("wraps Docker daemon failures with a user-facing hint", async () => {
    const error = Object.assign(
      new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock."),
      {
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
        code: "ECONNREFUSED",
      },
    );

    execaMock.mockRejectedValueOnce(error);

    const result = await buildWorkerImage({
      tag: "worker:latest",
      dockerfile: "Dockerfile",
      context: ".",
    }).catch((err) => err);

    expect(result).toBeInstanceOf(UserFacingError);

    const userError = result as UserFacingError;
    expect(userError.code).toBe(USER_FACING_ERROR_CODES.docker);
    expect(userError.hint).toContain("--local-worker");
    expect(userError.cause).toBeInstanceOf(Error);
    expect((userError.cause as Error).message).toContain("Cannot connect to the Docker daemon");
  });
});
