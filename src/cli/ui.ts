/*
 * UI CLI helpers for starting the visualizer server and opening the browser.
 * Assumptions: localhost-only server; query params identify the project/run.
 * Common usage: `mycelium ui`, plus run/resume hooks for auto-launch.
 */

import { execa } from "execa";

import type { AppContext } from "../app/context.js";
import { createAppPathsContext } from "../app/paths.js";
import type { ProjectConfig, UiConfig } from "../core/config.js";
import { loadRunStateForProject } from "../core/state-store.js";
import { startUiServer, type UiServerHandle } from "../ui/server.js";

import { createRunStopSignalHandler } from "./signal-handlers.js";

// =============================================================================
// TYPES
// =============================================================================

export type UiOverrides = {
  enabled?: boolean;
  port?: number;
  openBrowser?: boolean;
};

export type UiRuntimeConfig = {
  enabled: boolean;
  port: number;
  openBrowser: boolean;
};

export type UiStartResult = {
  handle: UiServerHandle;
  url: string;
};

export type UiCommandOptions = {
  runId?: string;
  port?: number;
  openBrowser?: boolean;
};

// =============================================================================
// UI COMMAND
// =============================================================================

export async function uiCommand(
  projectName: string,
  config: ProjectConfig,
  opts: UiCommandOptions,
  appContext?: AppContext,
): Promise<void> {
  const paths = appContext?.paths ?? createAppPathsContext({ repoPath: config.repo_path });
  const resolved = await loadRunStateForProject(projectName, opts.runId, paths);
  if (!resolved) {
    printRunNotFound(projectName, opts.runId);
    return;
  }

  const runtime = resolveUiRuntimeConfig(config.ui, {
    enabled: true,
    port: opts.port,
    openBrowser: opts.openBrowser,
  });

  let uiStart: UiStartResult;
  try {
    const started = await launchUiServer({
      projectName,
      runId: resolved.runId,
      runtime,
      onError: "throw",
      appContext,
    });

    if (!started) {
      console.error("UI server did not start.");
      process.exitCode = 1;
      return;
    }

    uiStart = started;
  } catch (err) {
    console.error(formatUiStartError(err, runtime.port));
    process.exitCode = 1;
    return;
  }

  console.log(`UI server running at ${uiStart.url}`);
  await maybeOpenUiBrowser(uiStart.url, runtime.openBrowser);

  const stopHandler = createRunStopSignalHandler({
    onSignal: (signal) => {
      console.log(`Received ${signal}. Shutting down UI server.`);
    },
  });

  try {
    await waitForAbort(stopHandler.signal);
  } finally {
    stopHandler.cleanup();
    await closeUiServer(uiStart.handle);
  }
}

// =============================================================================
// UI RUNTIME
// =============================================================================

export function resolveUiRuntimeConfig(
  uiConfig: UiConfig,
  overrides: UiOverrides = {},
): UiRuntimeConfig {
  return {
    enabled: overrides.enabled ?? uiConfig.enabled,
    port: overrides.port ?? uiConfig.port,
    openBrowser: overrides.openBrowser ?? uiConfig.open_browser,
  };
}

export async function launchUiServer(args: {
  projectName: string;
  runId: string;
  runtime: UiRuntimeConfig;
  onError: "warn" | "throw";
  appContext?: AppContext;
}): Promise<UiStartResult | null> {
  if (!args.runtime.enabled) {
    return null;
  }

  try {
    const appContext = args.appContext;
    if (!appContext) {
      const err = new Error(
        "App context is required to start the UI server. Create one via createAppContext() or loadAppContext().",
      );
      if (args.onError === "warn") {
        console.warn(formatUiStartWarning(err, args.runtime.port));
        return null;
      }
      throw err;
    }

    const handle = await startUiServer({
      project: args.projectName,
      runId: args.runId,
      port: args.runtime.port,
      appContext,
    });

    return {
      handle,
      url: buildUiUrl(handle.url, args.projectName, args.runId),
    };
  } catch (err) {
    if (args.onError === "warn") {
      console.warn(formatUiStartWarning(err, args.runtime.port));
      return null;
    }
    throw err;
  }
}

// =============================================================================
// UI BROWSER OPEN
// =============================================================================

export async function maybeOpenUiBrowser(url: string, openBrowser: boolean): Promise<void> {
  if (!shouldOpenBrowser(openBrowser)) {
    return;
  }

  try {
    await openBrowserUrl(url);
  } catch {
    // Best-effort: the URL is already printed for manual open.
  }
}

// =============================================================================
// UI SHUTDOWN
// =============================================================================

export async function closeUiServer(handle: UiServerHandle | null): Promise<void> {
  if (!handle) return;

  try {
    await handle.close();
  } catch (err) {
    const detail = describeUiServerError(err);
    const suffix = detail ? ` ${detail}` : "";
    console.warn(`Warning: failed to close UI server.${suffix}`);
  }
}

// =============================================================================
// INTERNALS
// =============================================================================

function buildUiUrl(baseUrl: string, projectName: string, runId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("project", projectName);
  url.searchParams.set("runId", runId);
  return url.toString();
}

function shouldOpenBrowser(openBrowser: boolean): boolean {
  if (!openBrowser) return false;
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  return true;
}

async function openBrowserUrl(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execa("open", [url], { stdio: "ignore" });
    return;
  }

  if (process.platform === "win32") {
    await execa("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  await execa("xdg-open", [url], { stdio: "ignore" });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function formatUiStartWarning(err: unknown, port: number): string {
  const detail = describeUiServerError(err);
  const suffix = detail ? ` ${detail}` : "";
  return `Warning: UI server failed to start on port ${port}.${suffix} Continuing without UI.`;
}

function formatUiStartError(err: unknown, port: number): string {
  const detail = describeUiServerError(err);
  const suffix = detail ? ` ${detail}` : "";
  return `Failed to start UI server on port ${port}.${suffix}`;
}

function describeUiServerError(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE") {
      return "Port is already in use.";
    }
    if (code === "EACCES") {
      return "Permission denied binding the port.";
    }
    if (typeof code === "string") {
      return `Error code ${code}.`;
    }
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }

  return err ? String(err) : null;
}

function printRunNotFound(projectName: string, requestedRunId?: string): void {
  const notFound = requestedRunId
    ? `Run ${requestedRunId} not found for project ${projectName}.`
    : `No runs found for project ${projectName}.`;

  console.log(notFound);
  console.log(`Start a run with: mycelium run --project ${projectName}`);
  process.exitCode = 1;
}
