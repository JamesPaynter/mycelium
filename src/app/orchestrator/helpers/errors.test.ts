import { describe, expect, it } from "vitest";

import { formatErrorMessage, normalizeAbortReason } from "./errors.js";

describe("formatErrorMessage", () => {
  it("uses error messages when available", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-error values", () => {
    expect(formatErrorMessage("plain")).toBe("plain");
    expect(formatErrorMessage(42)).toBe("42");
  });
});

describe("normalizeAbortReason", () => {
  it("returns undefined for nullish inputs", () => {
    expect(normalizeAbortReason(undefined)).toBeUndefined();
    expect(normalizeAbortReason(null)).toBeUndefined();
  });

  it("prefers known signal or type fields", () => {
    expect(normalizeAbortReason({ signal: "SIGTERM" })).toBe("SIGTERM");
    expect(normalizeAbortReason({ type: "abort" })).toBe("abort");
  });

  it("handles errors and other values", () => {
    expect(normalizeAbortReason(new Error("stopped"))).toBe("stopped");
    expect(normalizeAbortReason(123)).toBe("123");
  });
});
