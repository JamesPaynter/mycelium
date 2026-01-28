import { describe, expect, it } from "vitest";

import { USER_FACING_ERROR_CODES, UserFacingError } from "../core/errors.js";

import { renderCliError } from "./error-format.js";

// =============================================================================
// HELPERS
// =============================================================================

const nonTtyStream = { isTTY: false };

function buildUserFacingError(): UserFacingError {
  return new UserFacingError({
    code: USER_FACING_ERROR_CODES.config,
    title: "Config error",
    message: "Missing config value",
    hint: "Run mycelium init",
    next: "Edit .mycelium/config.yaml",
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe("renderCliError", () => {
  it("renders user-facing errors in short mode without stack output", () => {
    const error = buildUserFacingError();

    const output = renderCliError(error, { stream: nonTtyStream });

    expect(output).toBe(
      [
        "Error: Config error",
        "Missing config value",
        "Hint: Run mycelium init",
        "Next: Edit .mycelium/config.yaml",
      ].join("\n"),
    );
  });

  it("includes debug details and stack output when debug is enabled", () => {
    const error = new UserFacingError({
      code: USER_FACING_ERROR_CODES.task,
      title: "Task failed",
      message: "Worker stopped",
      cause: new Error("boom"),
    });
    error.stack = "UserFacingError: Worker stopped\nat fake:1:1";

    const output = renderCliError(error, { debug: true, stream: nonTtyStream });

    expect(output).toBe(
      [
        "Error: Task failed",
        "Worker stopped",
        "Code: TASK_ERROR",
        "Name: UserFacingError",
        "Cause: boom",
        "Stack:",
        "  UserFacingError: Worker stopped",
        "  at fake:1:1",
      ].join("\n"),
    );
  });

  it("disables color for non-TTY output even when useColor is true", () => {
    const error = buildUserFacingError();

    const output = renderCliError(error, { stream: nonTtyStream, useColor: true });

    expect(output).toContain("Error: Config error");
    expect(output).not.toContain("\x1b[");
  });
});
