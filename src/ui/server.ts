import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfigForCli } from "../cli/config.js";
import { createUiRouter } from "./router.js";


// =============================================================================
// TYPES
// =============================================================================

export type StartUiServerOptions = {
  project: string;
  runId: string;
  port?: number;
};

export type UiServerHandle = {
  url: string;
  close: () => Promise<void>;
};


// =============================================================================
// PUBLIC API
// =============================================================================

export async function startUiServer(options: StartUiServerOptions): Promise<UiServerHandle> {
  if (!options.project) {
    throw new Error("Project name is required to start the UI server.");
  }
  if (!options.runId) {
    throw new Error("Run id is required to start the UI server.");
  }

  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0) {
    throw new Error("Port must be a non-negative integer.");
  }

  await ensureMyceliumHome(options.project);

  const staticRoot = resolveUiStaticRoot();
  const router = createUiRouter({
    projectName: options.project,
    runId: options.runId,
    staticRoot,
  });

  const server = http.createServer((req, res) => router(req, res));
  await listenOnLocalhost(server, port);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine UI server address.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () => closeServer(server),
  };
}


// =============================================================================
// INTERNALS
// =============================================================================

async function ensureMyceliumHome(projectName: string): Promise<void> {
  if (process.env.MYCELIUM_HOME) {
    return;
  }

  await loadConfigForCli({
    projectName,
    initIfMissing: true,
  });
}

function resolveUiStaticRoot(): string {
  const packageRoot = findPackageRoot(fileURLToPath(new URL(".", import.meta.url)));
  return path.join(packageRoot, "dist", "ui");
}

function findPackageRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("package.json not found while resolving UI static root");
}

function listenOnLocalhost(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };

    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
