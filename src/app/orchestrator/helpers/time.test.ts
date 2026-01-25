import { describe, expect, it } from "vitest";

import { averageRounded, secondsFromMs } from "./time.js";

describe("averageRounded", () => {
  it("returns zero when there is nothing to average", () => {
    expect(averageRounded(10, 0, 2)).toBe(0);
  });

  it("rounds averages to the requested decimals", () => {
    expect(averageRounded(10, 4, 1)).toBe(2.5);
  });
});

describe("secondsFromMs", () => {
  it("rounds milliseconds to seconds with millisecond precision", () => {
    expect(secondsFromMs(1234)).toBe(1.234);
  });

  it("returns zero for non-finite values", () => {
    expect(secondsFromMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
