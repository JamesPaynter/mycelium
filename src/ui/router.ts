import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { Paths } from "../core/paths.js";

import type { CodeGraphError } from "./code-graph.js";
import {
  buildApiErrorPayload,
  buildCodeGraphErrorPayload,
  buildInternalErrorDetails,
  type ApiErrorDetails,
} from "./http/errors.js";
import { queryCodeGraph, type CodeGraphQueryError } from "./queries/code-graph-queries.js";
import {
  queryComplianceReport,
  queryDoctorSnippet,
  queryOrchestratorEvents,
  queryTaskEvents,
  queryValidatorReport,
  type LogQueryError,
} from "./queries/log-queries.js";
import { queryRunsList, queryRunSummary, type RunQueryError } from "./queries/run-queries.js";

// =============================================================================
// TYPES
// =============================================================================

export type UiRouterOptions = {
  projectName: string;
  runId: string;
  staticRoot: string;
  paths?: Paths;
};

type ResolvedUiRouterOptions = UiRouterOptions & {
  staticRoot: string;
};

type ApiRouteMatch =
  | { type: "runs_list"; projectName: string }
  | { type: "summary"; projectName: string; runId: string }
  | { type: "code_graph"; projectName: string; runId: string }
  | { type: "orchestrator_events"; projectName: string; runId: string }
  | { type: "task_events"; projectName: string; runId: string; taskId: string }
  | { type: "task_doctor"; projectName: string; runId: string; taskId: string }
  | { type: "task_compliance"; projectName: string; runId: string; taskId: string }
  | {
      type: "validator_report";
      projectName: string;
      runId: string;
      validator: string;
      taskId: string;
    }
  | { type: "bad_request" }
  | { type: "not_found" };

type StaticFile = {
  path: string;
  size: number;
  contentType: string;
};

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
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendApiError(
        res,
        500,
        "internal_error",
        "Unexpected server error.",
        method === "HEAD",
        buildInternalErrorDetails(error),
      );
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

  if (route.projectName !== options.projectName) {
    sendApiError(res, 404, "not_found", "Run not found.", method === "HEAD");
    return;
  }

  if (route.type === "runs_list") {
    await handleRunsListRequest(res, method, url, route, options);
    return;
  }

  if (route.type === "summary") {
    await handleSummaryRequest(res, method, route, options);
    return;
  }

  if (route.type === "code_graph") {
    await handleCodeGraphRequest(res, method, url, route, options);
    return;
  }

  if (route.type === "orchestrator_events") {
    await handleOrchestratorEventsRequest(res, method, url, route, options);
    return;
  }

  if (route.type === "task_events") {
    await handleTaskEventsRequest(res, method, url, route, options);
    return;
  }

  if (route.type === "task_doctor") {
    await handleDoctorRequest(res, method, url, route, options);
    return;
  }

  if (route.type === "task_compliance") {
    await handleComplianceRequest(res, method, route, options);
    return;
  }

  if (route.type === "validator_report") {
    await handleValidatorReportRequest(res, method, route, options);
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

async function handleRunsListRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryRunsList({
    projectName: route.projectName,
    limit: url.searchParams.get("limit"),
    paths: options.paths,
  });

  if (!result.ok) {
    sendRunQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleSummaryRequest(
  res: ServerResponse,
  method: string,
  route: { projectName: string; runId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryRunSummary({
    projectName: route.projectName,
    runId: route.runId,
    paths: options.paths,
  });

  if (!result.ok) {
    sendRunQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleCodeGraphRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string; runId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryCodeGraph({
    projectName: route.projectName,
    runId: route.runId,
    baseSha: url.searchParams.get("baseSha"),
    paths: options.paths,
  });

  if (!result.ok) {
    if (isRunNotFoundError(result.error)) {
      sendApiError(
        res,
        404,
        "not_found",
        `Run ${route.runId} not found for project ${route.projectName}.`,
        method === "HEAD",
      );
      return;
    }

    const status = statusForCodeGraphError(result.error.code);
    sendCodeGraphError(res, status, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleOrchestratorEventsRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string; runId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryOrchestratorEvents({
    projectName: route.projectName,
    runId: route.runId,
    cursor: url.searchParams.get("cursor"),
    maxBytes: url.searchParams.get("maxBytes"),
    typeGlob: url.searchParams.get("typeGlob"),
    taskId: url.searchParams.get("taskId"),
    paths: options.paths,
  });

  if (!result.ok) {
    sendLogQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleTaskEventsRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string; runId: string; taskId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryTaskEvents({
    projectName: route.projectName,
    runId: route.runId,
    taskId: route.taskId,
    cursor: url.searchParams.get("cursor"),
    maxBytes: url.searchParams.get("maxBytes"),
    typeGlob: url.searchParams.get("typeGlob"),
    paths: options.paths,
  });

  if (!result.ok) {
    sendLogQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleDoctorRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  route: { projectName: string; runId: string; taskId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryDoctorSnippet({
    projectName: route.projectName,
    runId: route.runId,
    taskId: route.taskId,
    attempt: url.searchParams.get("attempt"),
    limit: url.searchParams.get("limit"),
    paths: options.paths,
  });

  if (!result.ok) {
    sendLogQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleComplianceRequest(
  res: ServerResponse,
  method: string,
  route: { projectName: string; runId: string; taskId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryComplianceReport({
    projectName: route.projectName,
    runId: route.runId,
    taskId: route.taskId,
    paths: options.paths,
  });

  if (!result.ok) {
    sendLogQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

async function handleValidatorReportRequest(
  res: ServerResponse,
  method: string,
  route: { projectName: string; runId: string; validator: string; taskId: string },
  options: ResolvedUiRouterOptions,
): Promise<void> {
  const result = await queryValidatorReport({
    projectName: route.projectName,
    runId: route.runId,
    validator: route.validator,
    taskId: route.taskId,
    paths: options.paths,
  });

  if (!result.ok) {
    sendLogQueryError(res, result.error, method === "HEAD");
    return;
  }

  sendApiOk(res, result.result, method === "HEAD");
}

// eslint-disable-next-line max-statements -- explicit route branching keeps paths easy to scan.
function matchApiRoute(pathname: string): ApiRouteMatch {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 4) {
    const [api, projects, projectSegment, runs] = segments;
    if (api !== "api" || projects !== "projects" || runs !== "runs") {
      return { type: "not_found" };
    }

    const projectName = safeDecodeSegment(projectSegment);
    if (!projectName) {
      return { type: "bad_request" };
    }

    return { type: "runs_list", projectName };
  }

  if (segments.length === 6) {
    const [api, projects, projectSegment, runs, runSegment, tail] = segments;
    if (api !== "api" || projects !== "projects" || runs !== "runs") {
      return { type: "not_found" };
    }

    const parsed = parseProjectRunSegments(projectSegment, runSegment);
    if (!parsed) {
      return { type: "bad_request" };
    }

    if (tail === "summary") {
      return { type: "summary", ...parsed };
    }

    if (tail === "code-graph") {
      return { type: "code_graph", ...parsed };
    }

    return { type: "not_found" };
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

  if (segments.length === 8) {
    const [api, projects, projectSegment, runs, runSegment, tasks, taskSegment, tail] = segments;
    if (api !== "api" || projects !== "projects" || runs !== "runs" || tasks !== "tasks") {
      return { type: "not_found" };
    }

    const parsed = parseProjectRunSegments(projectSegment, runSegment);
    if (!parsed) {
      return { type: "bad_request" };
    }

    const taskId = safeDecodeSegment(taskSegment);
    if (!taskId) {
      return { type: "bad_request" };
    }

    if (tail === "events") {
      return { type: "task_events", ...parsed, taskId };
    }

    if (tail === "doctor") {
      return { type: "task_doctor", ...parsed, taskId };
    }

    if (tail === "compliance") {
      return { type: "task_compliance", ...parsed, taskId };
    }

    return { type: "not_found" };
  }

  if (segments.length === 10) {
    const [
      api,
      projects,
      projectSegment,
      runs,
      runSegment,
      validators,
      validatorSegment,
      tasks,
      taskSegment,
      report,
    ] = segments;
    if (
      api !== "api" ||
      projects !== "projects" ||
      runs !== "runs" ||
      validators !== "validators" ||
      tasks !== "tasks" ||
      report !== "report"
    ) {
      return { type: "not_found" };
    }

    const parsed = parseProjectRunSegments(projectSegment, runSegment);
    if (!parsed) {
      return { type: "bad_request" };
    }

    const validator = safeDecodeSegment(validatorSegment);
    if (!validator) {
      return { type: "bad_request" };
    }

    const taskId = safeDecodeSegment(taskSegment);
    if (!taskId) {
      return { type: "bad_request" };
    }

    return { type: "validator_report", ...parsed, validator, taskId };
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

// eslint-disable-next-line max-params -- keep response arguments explicit at call sites.
function sendApiError(
  res: ServerResponse,
  status: number,
  code: "not_found" | "bad_request" | "internal_error",
  message: string,
  isHead: boolean,
  details?: ApiErrorDetails,
): void {
  sendJson(res, status, buildApiErrorPayload({ code, message, details }), isHead);
}

function sendCodeGraphError(
  res: ServerResponse,
  status: number,
  error: CodeGraphError,
  isHead: boolean,
): void {
  sendJson(res, status, buildCodeGraphErrorPayload(error), isHead);
}

// =============================================================================
// QUERY ERROR MAPPING
// =============================================================================

function sendRunQueryError(res: ServerResponse, error: RunQueryError, isHead: boolean): void {
  switch (error.code) {
    case "bad_request":
      sendApiError(res, 400, "bad_request", error.message, isHead);
      return;
    case "not_found":
      sendApiError(res, 404, "not_found", error.message, isHead);
      return;
  }
}

function sendLogQueryError(res: ServerResponse, error: LogQueryError, isHead: boolean): void {
  switch (error.code) {
    case "bad_request":
      sendApiError(res, 400, "bad_request", error.message, isHead);
      return;
    case "not_found":
      sendApiError(res, 404, "not_found", error.message, isHead);
      return;
    case "report_too_large":
      sendApiError(res, 413, "bad_request", error.message, isHead);
      return;
  }
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
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".gif": "image/gif",
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

function isRunNotFoundError(
  error: CodeGraphQueryError,
): error is { code: "run_not_found"; message: string } {
  return error.code === "run_not_found";
}

function statusForCodeGraphError(code: CodeGraphError["code"]): number {
  switch (code) {
    case "INVALID_BASE_SHA":
      return 400;
    case "MODEL_NOT_FOUND":
    case "REPO_NOT_FOUND":
    case "BASE_SHA_RESOLUTION_FAILED":
      return 404;
    default:
      return 500;
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
