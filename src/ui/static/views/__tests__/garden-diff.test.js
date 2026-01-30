import { afterEach, describe, expect, it, vi } from "vitest";

import { createGardenView } from "../garden.js";

const ORIGINAL_DOCUMENT = globalThis.document;

function createClassList(element) {
  return {
    add: (...names) => {
      const classes = new Set(element.className.split(/\s+/).filter(Boolean));
      for (const name of names) {
        if (name) classes.add(name);
      }
      element.className = Array.from(classes).join(" ");
    },
    remove: (...names) => {
      const classes = new Set(element.className.split(/\s+/).filter(Boolean));
      for (const name of names) {
        classes.delete(name);
      }
      element.className = Array.from(classes).join(" ");
    },
    contains: (name) => element.className.split(/\s+/).includes(name),
  };
}

function hasClass(element, className) {
  return element.className.split(/\s+/).includes(className);
}

function createStubElement(tagName = "div") {
  const element = {
    tagName: tagName.toUpperCase(),
    className: "",
    style: {},
    textContent: "",
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertBefore(child, reference) {
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index === -1) {
        this.children.push(child);
      } else {
        this.children.splice(index, 0, child);
      }
      return child;
    },
    querySelector(selector) {
      if (!selector?.startsWith(".")) return null;
      const className = selector.slice(1);
      return this.children.find((child) => hasClass(child, className)) ?? null;
    },
  };

  element.classList = createClassList(element);
  return element;
}

function createStubContainer() {
  const container = createStubElement("section");
  container.ownerDocument = {
    createElement: (tag) => createStubElement(tag),
  };
  return container;
}

function findChildByClass(container, className) {
  return container.children.find((child) => hasClass(child, className)) ?? null;
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createGardenView", () => {
  afterEach(() => {
    globalThis.document = ORIGINAL_DOCUMENT;
  });

  it("returns handlers that are safe without a garden container", async () => {
    globalThis.document = {
      getElementById: () => null,
    };

    const view = createGardenView({
      container: null,
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

  it("mounts Grove on activation and forwards state updates", async () => {
    const container = createStubContainer();
    const appState = { projectName: "demo", runId: "run-1" };
    const controller = {
      setTarget: vi.fn(),
      setSummary: vi.fn(),
      setActive: vi.fn(),
      setPollingPaused: vi.fn(),
      refresh: vi.fn(),
      reset: vi.fn(),
      unmount: vi.fn(),
    };
    const mountMyceliumGrove = vi.fn(() => controller);
    const loadGroveModule = vi.fn().mockResolvedValue({ mountMyceliumGrove });
    const fetchApi = vi.fn();

    globalThis.document = {
      getElementById: () => null,
    };

    const view = createGardenView({
      container,
      fetchApi,
      appState,
      loadGroveModule,
    });

    view.init();
    view.setActive(false);

    appState.projectName = "next";
    appState.runId = "run-2";
    view.reset();

    const summary = { runId: "run-2", status: "running", tasks: [] };
    view.onSummary(summary);

    view.setActive(true);
    await flushPromises();

    expect(mountMyceliumGrove).toHaveBeenCalledTimes(1);
    const [host, opts] = mountMyceliumGrove.mock.calls[0];
    expect(host).toBe(findChildByClass(container, "grove-host"));
    expect(opts).toEqual(
      expect.objectContaining({
        projectName: "next",
        runId: "run-2",
        pollingPaused: false,
        active: true,
        assetBase: "/grove",
        fetchApi,
      }),
    );
    expect(controller.setSummary).toHaveBeenCalledWith(summary);

    view.setPollingPaused(true);
    expect(controller.setPollingPaused).toHaveBeenCalledWith(true);

    appState.projectName = "final";
    appState.runId = "run-3";
    view.reset();
    expect(controller.setTarget).toHaveBeenCalledWith("final", "run-3");

    view.setActive(false);
    expect(controller.unmount).toHaveBeenCalledTimes(1);
  });
});
