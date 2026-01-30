import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { ensureGroveStyles } from "./styles/groveStyles";
import GroveShell from "./ui/GroveShell";
import { useGroveRuntimeStore, type GroveController, type GroveMountOptions } from "./store/runtimeStore";

export type { GroveController, GroveMountOptions };

export function mountMyceliumGrove(host: HTMLElement, opts: GroveMountOptions): GroveController {
  if (!host) {
    throw new Error("mountMyceliumGrove: host element is required");
  }

  ensureGroveStyles();

  const root: Root = createRoot(host);
  root.render(<GroveShell />);

  // Configure runtime + kick loops
  useGroveRuntimeStore.getState().mount(opts);

  return {
    setTarget: (projectName, runId) => useGroveRuntimeStore.getState().setTarget(projectName, runId),
    setSummary: (summary) => useGroveRuntimeStore.getState().setSummary(summary),
    setActive: (active) => useGroveRuntimeStore.getState().setActive(active),
    setPollingPaused: (paused) => useGroveRuntimeStore.getState().setPollingPaused(paused),
    refresh: () => useGroveRuntimeStore.getState().refresh(),
    reset: () => useGroveRuntimeStore.getState().reset(),
    unmount: () => {
      useGroveRuntimeStore.getState().unmount();
      root.unmount();
    },
  };
}
