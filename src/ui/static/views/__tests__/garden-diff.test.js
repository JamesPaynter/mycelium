import { afterEach, describe, expect, it } from "vitest";

import { createGardenView } from "../garden.js";

const ORIGINAL_DOCUMENT = globalThis.document;

describe("createGardenView", () => {
  afterEach(() => {
    globalThis.document = ORIGINAL_DOCUMENT;
  });

  it("returns handlers that are safe without a garden container", async () => {
    globalThis.document = {
      getElementById: () => null,
    };

    const view = createGardenView({
      appState: { projectName: "demo", runId: "run-1" },
      actions: {},
      fetchApi: () => Promise.resolve(null),
    });

    expect(view).toEqual(
      expect.objectContaining({
        init: expect.any(Function),
        reset: expect.any(Function),
        onSummary: expect.any(Function),
        onSelectionChanged: expect.any(Function),
        setActive: expect.any(Function),
        setPollingPaused: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );

    expect(() => view.init()).not.toThrow();
    expect(() => view.reset()).not.toThrow();
    expect(() => view.onSummary({})).not.toThrow();
    expect(() => view.onSelectionChanged()).not.toThrow();
    expect(() => view.setActive(true)).not.toThrow();
    expect(() => view.setPollingPaused(true)).not.toThrow();
    await expect(view.refresh()).resolves.toBeUndefined();
  });
});
