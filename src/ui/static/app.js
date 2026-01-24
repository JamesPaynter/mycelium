// Mycelium UI app shell.
// Purpose: manage routing, shared state, and summary polling for multi-view UI.
// Usage: open /?project=...&runId=...&view=list|garden|map.

import { createGardenView } from "./views/garden.js";
import { createListView } from "./views/list.js";
import { createMapView } from "./views/map.js";

const SUMMARY_POLL_INTERVAL_MS = 2000;

const appState = {
  projectName: "",
  runId: "",
  runs: [],
  runsProject: "",
  summary: null,
  selectedTaskId: null,
  preferredTaskId: "",
  queryTaskId: "",
  pollingPaused: false,
  activeView: "list",
  summaryTimerId: null,
  isSummaryLoading: false,
  isRunsLoading: false,
};

const elements = {
  projectInput: document.getElementById("project-input"),
  runInput: document.getElementById("run-input"),
  runSelect: document.getElementById("run-select"),
  applyTargetButton: document.getElementById("apply-target"),
  refreshSummaryButton: document.getElementById("refresh-summary"),
  pauseTailToggle: document.getElementById("pause-tail"),
  globalError: document.getElementById("global-error"),
  viewTabs: Array.from(document.querySelectorAll(".view-tab")),
  viewContainers: Array.from(document.querySelectorAll(".view")),
};

const viewActions = {
  setSelectedTask,
  navigate,
  requestRefresh,
};

const views = {
  list: createListView({ appState, actions: viewActions, fetchApi }),
  garden: createGardenView({ appState, actions: viewActions, fetchApi }),
  map: createMapView({ appState }),
};

init();


// =============================================================================
// INITIALIZATION
// =============================================================================

function init() {
  if (!elements.projectInput) {
    return;
  }

  wireControls();
  initViews();
  loadTargetFromQuery();
  void maybeLoadRunsFromInputs();
  setActiveView(appState.activeView, { skipUrlUpdate: true });
}

function wireControls() {
  elements.applyTargetButton.addEventListener("click", () => {
    const projectName = elements.projectInput.value.trim();
    const runId = elements.runInput.value.trim();
    if (!projectName) {
      setGlobalError("Project is required.");
      return;
    }
    if (!runId) {
      setGlobalError("Run id is required.");
      void fetchRuns(projectName);
      return;
    }
    setGlobalError("");
    setTarget(projectName, runId);
  });

  elements.refreshSummaryButton.addEventListener("click", () => {
    void requestRefresh();
  });

  elements.projectInput.addEventListener("change", () => {
    const projectName = elements.projectInput.value.trim();
    if (!projectName) {
      appState.runs = [];
      appState.runsProject = "";
      renderRunOptions();
      return;
    }

    void fetchRuns(projectName);
  });

  elements.runSelect?.addEventListener("change", () => {
    const runId = elements.runSelect.value;
    if (runId) {
      elements.runInput.value = runId;
    }
  });

  elements.pauseTailToggle.addEventListener("change", () => {
    appState.pollingPaused = elements.pauseTailToggle.checked;
    views.list.setPollingPaused(appState.pollingPaused);
    views.garden.setPollingPaused?.(appState.pollingPaused);
  });

  for (const tab of elements.viewTabs) {
    tab.addEventListener("click", () => {
      navigate(tab.dataset.view);
    });
  }
}

function initViews() {
  for (const view of Object.values(views)) {
    view.init?.();
  }
}

function loadTargetFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const projectName = params.get("project")?.trim() ?? "";
  const runId = params.get("runId")?.trim() ?? "";
  const preferredTaskId = params.get("taskId")?.trim() ?? "";
  const view = params.get("view")?.trim() ?? "";

  appState.activeView = normalizeView(view);

  if (projectName) elements.projectInput.value = projectName;
  if (runId) elements.runInput.value = runId;

  if (preferredTaskId) {
    appState.preferredTaskId = preferredTaskId;
    appState.queryTaskId = preferredTaskId;
  }

  if (projectName && runId) {
    setTarget(projectName, runId, { preserveQueryTaskId: true });
  }
}

function maybeLoadRunsFromInputs() {
  const projectName = elements.projectInput.value.trim();
  if (!projectName) return;
  void fetchRuns(projectName);
}


// =============================================================================
// ROUTING + QUERY PARAMS
// =============================================================================

function navigate(viewName) {
  setActiveView(viewName);
}

function setActiveView(viewName, options = {}) {
  const normalizedView = normalizeView(viewName);
  const hasChanged = normalizedView !== appState.activeView;
  appState.activeView = normalizedView;

  updateViewTabs();
  updateViewContainers();

  for (const [name, view] of Object.entries(views)) {
    view.setActive?.(name === normalizedView);
  }

  if (!options.skipUrlUpdate && hasChanged) {
    updateQueryParams();
  }
}

function updateViewTabs() {
  for (const tab of elements.viewTabs) {
    const isSelected = tab.dataset.view === appState.activeView;
    tab.setAttribute("aria-selected", String(isSelected));
  }
}

function updateViewContainers() {
  for (const container of elements.viewContainers) {
    const isActive = container.dataset.view === appState.activeView;
    container.hidden = !isActive;
  }
}

function updateQueryParams() {
  const params = new URLSearchParams();
  if (appState.projectName) params.set("project", appState.projectName);
  if (appState.runId) params.set("runId", appState.runId);
  if (appState.queryTaskId) params.set("taskId", appState.queryTaskId);
  if (appState.activeView !== "list") {
    params.set("view", appState.activeView);
  }

  const query = params.toString();
  const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState({}, "", url);
}

function normalizeView(viewName) {
  if (viewName === "garden" || viewName === "map" || viewName === "list") {
    return viewName;
  }
  return "list";
}


// =============================================================================
// TARGET + POLLING
// =============================================================================

function setTarget(projectName, runId, options = {}) {
  const { preserveQueryTaskId = false } = options;

  if (projectName === appState.projectName && runId === appState.runId) {
    return;
  }

  appState.projectName = projectName;
  appState.runId = runId;
  appState.summary = null;
  appState.selectedTaskId = null;
  if (!preserveQueryTaskId) {
    appState.queryTaskId = "";
  }

  views.list.reset();
  views.garden.reset?.();
  views.map.reset?.();
  updateQueryParams();
  void fetchRuns(projectName);
  startSummaryPolling();

  if (appState.activeView === "map") {
    void views.map.refresh?.();
  }
}

function startSummaryPolling() {
  stopSummaryPolling();
  void fetchSummary();
  appState.summaryTimerId = window.setInterval(() => {
    void fetchSummary();
  }, SUMMARY_POLL_INTERVAL_MS);
}

function stopSummaryPolling() {
  if (appState.summaryTimerId !== null) {
    window.clearInterval(appState.summaryTimerId);
    appState.summaryTimerId = null;
  }
}

async function requestRefresh() {
  const projectName = elements.projectInput.value.trim();
  if (projectName) {
    await fetchRuns(projectName);
  }
  await fetchSummary();
  await views.list.refresh();
  await views.map.refresh?.();
}

function setSelectedTask(taskId) {
  if (taskId === appState.selectedTaskId) {
    return;
  }

  appState.selectedTaskId = taskId;
  views.list.onSelectionChanged(taskId);
}


// =============================================================================
// SUMMARY API
// =============================================================================

async function fetchSummary() {
  if (!hasTarget()) return;
  if (appState.isSummaryLoading) return;

  appState.isSummaryLoading = true;
  try {
    const summary = await fetchApi(buildSummaryUrl());
    appState.summary = summary;
    views.list.onSummary(summary);
    views.garden.onSummary?.(summary);
    setGlobalError("");
  } catch (error) {
    setGlobalError(toErrorMessage(error));
  } finally {
    appState.isSummaryLoading = false;
  }
}


// =============================================================================
// RUN LIST API
// =============================================================================

async function fetchRuns(projectName) {
  if (!projectName) return;
  if (appState.isRunsLoading && appState.runsProject === projectName) return;

  const isNewProject = appState.runsProject !== projectName;
  appState.isRunsLoading = true;
  appState.runsProject = projectName;
  if (isNewProject) {
    appState.runs = [];
    renderRunOptions();
  }
  try {
    const result = await fetchApi(buildRunsUrl(projectName));
    const runs = Array.isArray(result.runs) ? result.runs : [];
    appState.runs = runs;
    renderRunOptions();
  } catch (error) {
    setGlobalError(toErrorMessage(error));
  } finally {
    appState.isRunsLoading = false;
  }
}

function renderRunOptions() {
  if (!elements.runSelect) return;

  elements.runSelect.innerHTML = "";
  elements.runSelect.disabled = appState.runs.length === 0;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = appState.runs.length > 0 ? "Recent runs" : "No runs found";
  elements.runSelect.appendChild(placeholder);

  const fragment = document.createDocumentFragment();
  for (const run of appState.runs) {
    const option = document.createElement("option");
    option.value = run.runId;
    option.textContent = formatRunOption(run);
    fragment.appendChild(option);
  }

  elements.runSelect.appendChild(fragment);

  const selected = elements.runInput.value.trim();
  if (selected) {
    elements.runSelect.value = selected;
  }
}

function buildRunsUrl(projectName) {
  return `/api/projects/${encodeURIComponent(projectName)}/runs`;
}

function formatRunOption(run) {
  const updatedAt = run.updatedAt ? formatTimestamp(run.updatedAt) : "n/a";
  const tasks = Number.isInteger(run.taskCount) ? `${run.taskCount} tasks` : "tasks n/a";
  return `${run.runId} | ${run.status} | ${tasks} | ${updatedAt}`;
}


// =============================================================================
// UTILITIES
// =============================================================================

function hasTarget() {
  return Boolean(appState.projectName && appState.runId);
}

function buildSummaryUrl() {
  return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
    appState.runId,
  )}/summary`;
}

async function fetchApi(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}`);
  }

  if (!response.ok || !payload.ok) {
    const message = payload?.error?.message || response.statusText || "Request failed";
    throw new Error(message);
  }

  return payload.result;
}

function setGlobalError(message) {
  setErrorMessage(elements.globalError, message);
}

function setErrorMessage(target, message) {
  if (!target) return;

  if (!message) {
    target.textContent = "";
    target.classList.add("hidden");
    return;
  }

  target.textContent = message;
  target.classList.remove("hidden");
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatTimestamp(ts) {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
