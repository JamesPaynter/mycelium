import { afterEach, beforeEach } from "vitest";

import { setDefaultAppPathsContext } from "../src/app/paths.js";
import { clearDefaultPathsContext } from "../src/core/paths.js";


// =============================================================================
// MYCELIUM_HOME SYNC
// =============================================================================

type EnvProxyState = {
  __myceliumEnvProxy?: boolean;
};

function syncDefaultPathsFromEnv(): void {
  const home = process.env.MYCELIUM_HOME;
  if (home && home.length > 0) {
    setDefaultAppPathsContext({ myceliumHome: home });
    return;
  }

  clearDefaultPathsContext();
}

function installEnvProxy(): void {
  const globalState = globalThis as EnvProxyState;
  if (globalState.__myceliumEnvProxy) {
    syncDefaultPathsFromEnv();
    return;
  }

  const envProxy = new Proxy(process.env, {
    set(target, prop, value) {
      target[prop as string] = value as string;
      if (prop === "MYCELIUM_HOME") {
        syncDefaultPathsFromEnv();
      }
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop as string];
      if (prop === "MYCELIUM_HOME") {
        syncDefaultPathsFromEnv();
      }
      return true;
    },
  });

  process.env = envProxy;
  globalState.__myceliumEnvProxy = true;
  syncDefaultPathsFromEnv();
}

installEnvProxy();

beforeEach(() => {
  syncDefaultPathsFromEnv();
});

afterEach(() => {
  syncDefaultPathsFromEnv();
});
