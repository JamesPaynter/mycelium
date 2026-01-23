import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonlFromCursor } from "../core/log-query.js";
import { resolveRunLogsDir } from "../core/paths.js";
import { loadRunStateForProject, summarizeRunState } from "../core/state-store.js";


// =============================================================================
// TYPES
// =============================================================================

export type UiRouterOptions = {
  projectName: string;
  runId: string;
  staticRoot: string;
};

type ResolvedUiRouterOptions = UiRouterOptions & {
  staticRoot: string;
};

type ApiRouteMatch =
  | { type: "summary"; projectName: string; runId: string }
  | { type: "orchestrator_events"; projectName: string; runId: string }
  | { type: "bad_request" }
  | { type: "not_found" };

type StaticFile = {
  path: string;
  size: number;
  contentType: string;
};

type OptionalNumberParseResult = { ok: true; value: number | null } | { ok: false };


// =============================================================================
// PUBLIC API
// =============================================================================

export function createUiRouter(
  options: UiRouterOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const resolved: ResolvedUiRouterOptions = {
    ...options,
    staticRoot: path.resolve(options.staticRoot),
  };

  return (req, res) => {
    void routeRequest(req, res, resolved);
  };
}


// =============================================================================
// ROUTING
// =============================================================================

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  const isApiRequest = rawUrl.startsWith("/api/");

  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    if (isApiRequest) {
      sendApiError(res, 400, "bad_request", "Malformed request URL.", method === "HEAD");
      return;
    }
    sendText(res, 400, "Bad request.", method === "HEAD");
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(res, method, url, options);
      return;
    }

    await handleStaticRequest(res, method, url, options);
  } catch {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendApiError(res, 500, "internal_error", "Unexpected server error.", method === "HEAD");
      return;
    }

    sendText(res, 500, "Unexpected server error.", method === "HEAD");
  }
}

async function handleApiRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  options: ResolvedUiRouterOptions,
): Promise<void> {
  if (!isReadMethod(method)) {
    sendApiError(res, 400, "bad_request", `Method ${method} not allowed.`, method === "HEAD");
    return;
  }

  const route = matchApiRoute(url.pathname);
  if (route.type === "not_found") {
    sendApiError(res, 404, "not_found", "Endpoint not found.", method === "HEAD");
    return;
  }
  if (route.type === "bad_request") {
    sendApiError(res, 400, "bad_request", "Invalid project or run id.", method === "HEAD");
    return;
  }

  if (route.projectName !== options.projectName || route.runId !== options.runId) {
    sendApiError(res, 404, "not_found", "Run not found.", method === "HEAD");
    return;
  }

  if (route.type === "summary") {
    await handleSummaryRequest(res, method, route);
    return;
  }

  if (route.type === "orchestrator_events") {
    await handleOrchestratorEventsRequest(res, method, url, route);
    return;
  }

  sendApiError(res, 404, "not_found", "Endpoint not found.", method === "HEAD");
}

async function handleStaticRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  options: ResolvedUiRouterOptions,
): Promise<void> {
  if (!isReadMethod(method)) {
    sendText(res, 405, "Method not allowed.", method === "HEAD");
    return;
  }

  const decodedPath = safeDecodePathname(url.pathname);
  if (!decodedPath) {
    sendText(res, 400, "Bad request.", method === "HEAD");
    return;
  }

  const isIndexRequest = decodedPath === "/" || decodedPath === "/index.html";
  const relativePath = normalizeStaticPath(decodedPath);
  const candidate = resolveSafePath(options.staticRoot, relativePath);
  if (!candidate) {
    sendText(res, 400, "Bad request.", method === "HEAD");
    return;
  }

  const staticFile = await findStaticFile(candidate);

  if (staticFile) {
    await sendStaticFile(res, staticFile, method === "HEAD");
    return;
  }

  if (isIndexRequest) {
    sendPlaceholder(res, options, method === "HEAD");
    return;
  }

  sendText(res, 404, "Not found.", method === "HEAD");
}


// =============================================================================
// API ROUTES
// =============================================================================

async function handleSummaryRequest(
  res: ServerResponse,
  method: string,
  route: { projectName: string; runId: string },
): Promise<void> {
  const resolved = await loadRunStateForProject(route.projectName, route.runId);
  if (!resolved) {
    sendApiError(
      res,
      404,
      "not_found",
      `Run ${route.runId} not found for project ${route.projectName}.`,
      method === "HEAD",
    );
    return;
  }

  const summary = summarizeRunState(resolved.state);
  sendApiOk(res, summary, method === "HEAD");
}

async function handleOrchestratorEventsRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string; runId: string },
): Promise<void> {
  const cursorResult = parseCursorParam(url.searchParams.get("cursor"));
  if (!cursorResult.ok) {
    sendApiError(res, 400, "bad_request", "Invalid cursor value.", method === "HEAD");
    return;
  }

  const maxBytesResult = parseOptionalNonNegativeInteger(url.searchParams.get("maxBytes"));
  if (!maxBytesResult.ok) {
    sendApiError(res, 400, "bad_request", "Invalid maxBytes value.", method === "HEAD");
    return;
  }

  const typeGlob = parseOptionalString(url.searchParams.get("typeGlob"));
  const taskId = parseOptionalString(url.searchParams.get("taskId"));

  const resolved = resolveRunLogsDir(route.projectName, route.runId);
  if (!resolved) {
    sendApiError(res, 404, "not_found", "Run logs not found.", method === "HEAD");
    return;
  }

  const logPath = path.join(resolved.dir, "orchestrator.jsonl");
  const logExists = await fileExists(logPath);
  if (!logExists) {
    sendApiError(res, 404, "not_found", "Run logs not found.", method === "HEAD");
    return;
  }

  const readOptions = maxBytesResult.value === null ? {} : { maxBytes: maxBytesResult.value };
  const result = await readJsonlFromCursor(
    logPath,
    cursorResult.value,
    { taskId, typeGlob },
    readOptions,
  );

  sendApiOk(
    res,
    {
      file: "orchestrator.jsonl",
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      truncated: result.truncated,
      lines: result.lines,
    },
    method === "HEAD",
  );
}

function matchApiRoute(pathname: string): ApiRouteMatch {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 6) {
    const [api, projects, projectSegment, runs, runSegment, summary] = segments;
    if (api !== "api" || projects !== "projects" || runs !== "runs" || summary !== "summary") {
      return { type: "not_found" };
    }

    const parsed = parseProjectRunSegments(projectSegment, runSegment);
    if (!parsed) {
      return { type: "bad_request" };
    }

    return { type: "summary", ...parsed };
  }

  if (segments.length === 7) {
    const [api, projects, projectSegment, runs, runSegment, orchestrator, events] = segments;
    if (
      api !== "api" ||
      projects !== "projects" ||
      runs !== "runs" ||
      orchestrator !== "orchestrator" ||
      events !== "events"
    ) {
      return { type: "not_found" };
    }

    const parsed = parseProjectRunSegments(projectSegment, runSegment);
    if (!parsed) {
      return { type: "bad_request" };
    }

    return { type: "orchestrator_events", ...parsed };
  }

  return { type: "not_found" };
}


// =============================================================================
// STATIC ASSETS
// =============================================================================

async function findStaticFile(candidate: string): Promise<StaticFile | null> {
  const resolved = await resolveExistingFile(candidate);
  if (!resolved) return null;

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) return null;

  return {
    path: resolved,
    size: stat.size,
    contentType: contentTypeForPath(resolved),
  };
}

async function resolveExistingFile(candidate: string): Promise<string | null> {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, "index.html");
      const indexStat = await fs.stat(indexPath);
      return indexStat.isFile() ? indexPath : null;
    }
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }

  return null;
}

function resolveSafePath(staticRoot: string, relativePath: string): string | null {
  const resolved = path.resolve(staticRoot, relativePath);
  const relative = path.relative(staticRoot, resolved);

  // Reject directory traversal attempts that escape the static root.
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

function normalizeStaticPath(pathname: string): string {
  if (pathname === "/") return "index.html";

  const trimmed = pathname.replace(/^\/+/, "");
  if (!trimmed) return "index.html";
  if (pathname.endsWith("/")) {
    return path.join(trimmed, "index.html");
  }

  return trimmed;
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[ext];
  return contentType ?? "application/octet-stream";
}

async function sendStaticFile(
  res: ServerResponse,
  file: StaticFile,
  isHead: boolean,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", file.size);

  if (isHead) {
    res.end();
    return;
  }

  const data = await fs.readFile(file.path);
  res.end(data);
}

function sendPlaceholder(
  res: ServerResponse,
  options: ResolvedUiRouterOptions,
  isHead: boolean,
): void {
  const summaryPath = `/api/projects/${encodeURIComponent(options.projectName)}/runs/${encodeURIComponent(
    options.runId,
  )}/summary`;

  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8" />',
    "  <title>Mycelium UI</title>",
    "</head>",
    "<body>",
    "  <h1>Mycelium UI</h1>",
    "  <p>Static UI assets not found.</p>",
    `  <p>Expected: <code>${escapeHtml(options.staticRoot)}</code></p>`,
    `  <p>Project: <code>${escapeHtml(options.projectName)}</code></p>`,
    `  <p>Run: <code>${escapeHtml(options.runId)}</code></p>`,
    `  <p>Try the summary endpoint: <code>${escapeHtml(summaryPath)}</code></p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(html));

  if (isHead) {
    res.end();
    return;
  }

  res.end(html);
}


// =============================================================================
// API RESPONSES
// =============================================================================

function sendApiOk(res: ServerResponse, result: unknown, isHead: boolean): void {
  sendJson(res, 200, { ok: true, result }, isHead);
}

function sendApiError(
  res: ServerResponse,
  status: number,
  code: "not_found" | "bad_request" | "internal_error",
  message: string,
  isHead: boolean,
): void {
  sendJson(res, status, { ok: false, error: { code, message } }, isHead);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, isHead: boolean): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));

  if (isHead) {
    res.end();
    return;
  }

  res.end(body);
}


// =============================================================================
// UTILITIES
// =============================================================================

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function safeDecodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }

  if (!decoded) return null;
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }

  return decoded;
}

function parseProjectRunSegments(
  projectSegment: string,
  runSegment: string,
): { projectName: string; runId: string } | null {
  const projectName = safeDecodeSegment(projectSegment);
  const runId = safeDecodeSegment(runSegment);
  if (!projectName || !runId) {
    return null;
  }

  return { projectName, runId };
}

function safeDecodePathname(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseOptionalString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalNonNegativeInteger(value: string | null): OptionalNumberParseResult {
  if (value === null) {
    return { ok: true, value: null };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }

  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false };
  }

  return { ok: true, value: parsed };
}

function parseCursorParam(value: string | null): { ok: true; value: number } | { ok: false } {
  const parsed = parseOptionalNonNegativeInteger(value);
  if (!parsed.ok) {
    return { ok: false };
  }

  return { ok: true, value: parsed.value ?? 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
}

function sendText(res: ServerResponse, status: number, message: string, isHead: boolean): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(message));

  if (isHead) {
    res.end();
    return;
  }

  res.end(message);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: string }).code === "ENOENT";
}
