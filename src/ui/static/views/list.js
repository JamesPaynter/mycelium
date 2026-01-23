// List view renderer for the Mycelium UI.
// Purpose: render run summary, task table, and task detail/events for the List view.
// Usage: created by app.js and driven via onSummary / onSelectionChanged callbacks.

export function createListView({ appState, actions, fetchApi }) {
  const EVENTS_POLL_INTERVAL_MS = 2000;
  const MAX_EVENTS_PER_VIEW = 240;

  const viewState = {
    typeGlob: "",
    eventsByKey: new Map(),
    cursorByKey: new Map(),
    truncatedByKey: new Map(),
    lastEventByTask: new Map(),
    eventsTimerId: null,
    isEventsLoading: false,
    isActive: true,
  };

  const elements = {
    overviewSubtext: document.getElementById("overview-subtext"),
    runStatus: document.getElementById("run-status"),
    runStarted: document.getElementById("run-started"),
    runUpdated: document.getElementById("run-updated"),
    overviewGrid: document.getElementById("overview-grid"),
    humanReviewBody: document.getElementById("human-review-body"),
    topSpendersBody: document.getElementById("top-spenders-body"),
    tasksSubtext: document.getElementById("tasks-subtext"),
    tasksCount: document.getElementById("tasks-count"),
    tasksTableBody: document.getElementById("tasks-table-body"),
    taskDetailSubtext: document.getElementById("task-detail-subtext"),
    selectedTaskStatus: document.getElementById("selected-task-status"),
    taskId: document.getElementById("task-id"),
    taskAttempts: document.getElementById("task-attempts"),
    taskBranch: document.getElementById("task-branch"),
    taskThread: document.getElementById("task-thread"),
    typeFilterInput: document.getElementById("type-filter-input"),
    cursorInfo: document.getElementById("cursor-info"),
    resetCursorButton: document.getElementById("reset-cursor"),
    eventsMeta: document.getElementById("events-meta"),
    eventsList: document.getElementById("events-list"),
    doctorAttemptInput: document.getElementById("doctor-attempt-input"),
    doctorFetchButton: document.getElementById("doctor-fetch"),
    doctorOutput: document.getElementById("doctor-output"),
    complianceFetchButton: document.getElementById("compliance-fetch"),
    complianceOutput: document.getElementById("compliance-output"),
    validatorInput: document.getElementById("validator-input"),
    validatorFetchButton: document.getElementById("validator-fetch"),
    validatorOutput: document.getElementById("validator-output"),
    detailError: document.getElementById("detail-error"),
  };

  return {
    init,
    reset,
    onSummary,
    onSelectionChanged,
    setActive,
    setPollingPaused,
    refresh,
  };


  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    if (!elements.overviewSubtext) {
      return;
    }

    wireControls();
    renderEmptyState();
  }

  function wireControls() {
    elements.tasksTableBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr");
      if (!row) return;
      const taskId = row.dataset.taskId;
      if (!taskId) return;
      selectTask(taskId);
    });

    elements.typeFilterInput.addEventListener("change", () => {
      applyTypeFilter(elements.typeFilterInput.value.trim());
    });

    elements.typeFilterInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        applyTypeFilter(elements.typeFilterInput.value.trim());
      }
    });

    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        applyTypeFilter(button.dataset.filter ?? "");
      });
    });

    elements.resetCursorButton.addEventListener("click", () => {
      resetCursorForSelection();
    });

    elements.doctorFetchButton.addEventListener("click", () => {
      void fetchDoctorSnippet();
    });

    elements.complianceFetchButton.addEventListener("click", () => {
      void fetchComplianceReport();
    });

    elements.validatorFetchButton.addEventListener("click", () => {
      void fetchValidatorReport();
    });
  }


  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    viewState.typeGlob = "";
    viewState.eventsByKey.clear();
    viewState.cursorByKey.clear();
    viewState.truncatedByKey.clear();
    viewState.lastEventByTask.clear();

    stopEventsPolling();
    renderEmptyState();
  }

  function setActive(isActive) {
    viewState.isActive = isActive;
    if (isActive) {
      startEventsPolling();
    } else {
      stopEventsPolling();
    }
    updateEventsStatus();
  }

  function setPollingPaused() {
    updateEventsStatus();
    if (appState.pollingPaused) {
      stopEventsPolling();
    } else {
      startEventsPolling();
    }
  }

  function refresh() {
    if (!viewState.isActive) {
      return Promise.resolve();
    }
    return fetchTaskEvents();
  }


  // =============================================================================
  // SUMMARY + SELECTION
  // =============================================================================

  function onSummary(summary) {
    if (!summary) {
      renderEmptyState();
      return;
    }

    renderSummary(summary);
    ensureTaskSelection(summary);
  }

  function onSelectionChanged(taskId) {
    if (appState.summary) {
      const tasks = appState.summary.tasks ?? [];
      const task = tasks.find((item) => item.id === taskId) ?? null;
      renderTaskDetail(task);
      renderTaskTable(tasks, appState.summary.updatedAt);
    } else {
      renderTaskDetail(null);
    }

    updateEventsStatus();
    renderEvents();
    startEventsPolling();
  }

  function ensureTaskSelection(summary) {
    const tasks = summary.tasks ?? [];
    if (!tasks.length) {
      actions.setSelectedTask(null);
      renderTaskDetail(null);
      renderEvents();
      return;
    }

    const selectedExists = tasks.some((task) => task.id === appState.selectedTaskId);
    if (selectedExists) {
      renderTaskDetail(tasks.find((task) => task.id === appState.selectedTaskId));
      return;
    }

    if (appState.preferredTaskId) {
      const match = tasks.find((task) => task.id === appState.preferredTaskId);
      if (match) {
        actions.setSelectedTask(match.id);
        appState.preferredTaskId = "";
        return;
      }
    }

    const running = tasks.find((task) => task.status === "running");
    actions.setSelectedTask((running ?? tasks[0]).id);
  }

  function selectTask(taskId) {
    actions.setSelectedTask(taskId);
  }

  function applyTypeFilter(typeGlob) {
    viewState.typeGlob = typeGlob;
    elements.typeFilterInput.value = typeGlob;
    renderEvents();
    startEventsPolling();
  }

  function resetCursorForSelection() {
    const taskId = appState.selectedTaskId;
    if (!taskId) return;

    const key = eventKey(taskId, viewState.typeGlob);
    viewState.cursorByKey.set(key, 0);
    viewState.eventsByKey.set(key, []);
    viewState.truncatedByKey.set(key, false);
    renderEvents();
    startEventsPolling();
  }


  // =============================================================================
  // EVENTS POLLING
  // =============================================================================

  function startEventsPolling() {
    stopEventsPolling();
    if (!viewState.isActive) return;
    if (!appState.selectedTaskId) return;
    if (appState.pollingPaused) return;

    void fetchTaskEvents();
    viewState.eventsTimerId = window.setInterval(() => {
      void fetchTaskEvents();
    }, EVENTS_POLL_INTERVAL_MS);
  }

  function stopEventsPolling() {
    if (viewState.eventsTimerId !== null) {
      window.clearInterval(viewState.eventsTimerId);
      viewState.eventsTimerId = null;
    }
  }


  // =============================================================================
  // API REQUESTS
  // =============================================================================

  async function fetchTaskEvents() {
    if (!hasTarget()) return;
    if (!appState.selectedTaskId) return;
    if (viewState.isEventsLoading) return;

    const taskId = appState.selectedTaskId;
    const key = eventKey(taskId, viewState.typeGlob);
    const cursor = viewState.cursorByKey.get(key) ?? 0;

    viewState.isEventsLoading = true;
    try {
      const result = await fetchApi(buildTaskEventsUrl(taskId, cursor, viewState.typeGlob));
      const nextCursor = result.nextCursor ?? cursor;
      viewState.cursorByKey.set(key, nextCursor);
      viewState.truncatedByKey.set(key, Boolean(result.truncated));

      if (Array.isArray(result.lines) && result.lines.length > 0) {
        const events = viewState.eventsByKey.get(key) ?? [];
        const parsedEvents = result.lines.map(parseEventLine);
        const merged = events.concat(parsedEvents).slice(-MAX_EVENTS_PER_VIEW);
        viewState.eventsByKey.set(key, merged);

        for (const event of parsedEvents) {
          if (event.ts) {
            viewState.lastEventByTask.set(taskId, event.ts);
          }
        }
      }

      renderEvents();
      setDetailError("");
    } catch (error) {
      setDetailError(toErrorMessage(error));
    } finally {
      viewState.isEventsLoading = false;
    }
  }

  async function fetchDoctorSnippet() {
    const taskId = appState.selectedTaskId;
    if (!hasTarget() || !taskId) {
      setDetailError("Select a task before fetching diagnostics.");
      return;
    }

    const attemptValue = elements.doctorAttemptInput.value.trim();
    const attemptParam = attemptValue ? Number.parseInt(attemptValue, 10) : null;
    if (attemptValue && (!Number.isInteger(attemptParam) || attemptParam <= 0)) {
      setDetailError("Doctor attempt must be a positive integer.");
      return;
    }

    elements.doctorOutput.textContent = "Loading doctor snippet...";
    try {
      const result = await fetchApi(buildDoctorUrl(taskId, attemptParam));
      const header = result.file ? `File: ${result.file}\n\n` : "";
      elements.doctorOutput.textContent = `${header}${result.content ?? ""}`;
      setDetailError("");
    } catch (error) {
      elements.doctorOutput.textContent = "No data.";
      setDetailError(toErrorMessage(error));
    }
  }

  async function fetchComplianceReport() {
    const taskId = appState.selectedTaskId;
    if (!hasTarget() || !taskId) {
      setDetailError("Select a task before fetching diagnostics.");
      return;
    }

    elements.complianceOutput.textContent = "Loading compliance report...";
    try {
      const result = await fetchApi(buildComplianceUrl(taskId));
      const header = result.file ? `File: ${result.file}\n\n` : "";
      elements.complianceOutput.textContent = `${header}${formatJson(result.report)}`;
      setDetailError("");
    } catch (error) {
      elements.complianceOutput.textContent = "No data.";
      setDetailError(toErrorMessage(error));
    }
  }

  async function fetchValidatorReport() {
    const taskId = appState.selectedTaskId;
    if (!hasTarget() || !taskId) {
      setDetailError("Select a task before fetching diagnostics.");
      return;
    }

    const validatorName = elements.validatorInput.value.trim();
    if (!validatorName) {
      setDetailError("Enter a validator name.");
      return;
    }

    elements.validatorOutput.textContent = "Loading validator report...";
    try {
      const result = await fetchApi(buildValidatorUrl(taskId, validatorName));
      const header = result.file ? `File: ${result.file}\n\n` : "";
      elements.validatorOutput.textContent = `${header}${formatJson(result.report)}`;
      setDetailError("");
    } catch (error) {
      elements.validatorOutput.textContent = "No data.";
      setDetailError(toErrorMessage(error));
    }
  }


  // =============================================================================
  // RENDERING
  // =============================================================================

  function renderEmptyState() {
    elements.overviewSubtext.textContent = appState.projectName
      ? `Project ${appState.projectName} • Run ${appState.runId}`
      : "Waiting for project + run.";
    elements.runStatus.textContent = "—";
    elements.runStarted.textContent = "—";
    elements.runUpdated.textContent = "—";
    elements.overviewGrid.innerHTML = "";
    elements.tasksSubtext.textContent = "Select a task to view details.";
    elements.tasksCount.textContent = "0 tasks";
    elements.tasksTableBody.innerHTML = "";
    elements.taskDetailSubtext.textContent = "No task selected.";
    elements.selectedTaskStatus.textContent = "—";
    elements.selectedTaskStatus.className = "status-pill";
    elements.taskId.textContent = "—";
    elements.taskAttempts.textContent = "—";
    elements.taskBranch.textContent = "—";
    elements.taskThread.textContent = "—";
    elements.typeFilterInput.value = viewState.typeGlob;
    elements.doctorAttemptInput.value = "";
    elements.validatorInput.value = "";
    elements.cursorInfo.textContent = "Cursor: —";
    elements.eventsMeta.textContent = "Awaiting events.";
    elements.eventsList.innerHTML = "";
    elements.doctorOutput.textContent = "No data.";
    elements.complianceOutput.textContent = "No data.";
    elements.validatorOutput.textContent = "No data.";
    renderHumanReviewList([]);
    renderTopSpendersList([]);
  }

  function renderSummary(summary) {
    elements.overviewSubtext.textContent = `Project ${appState.projectName} • Run ${summary.runId}`;
    elements.runStatus.textContent = summary.status;
    elements.runStarted.textContent = formatTimestamp(summary.startedAt);
    elements.runUpdated.textContent = formatTimestamp(summary.updatedAt);

    renderOverviewStats(summary);
    renderHumanReviewList(summary.humanReview ?? []);
    renderTopSpendersList(summary.topSpenders ?? []);
    renderTaskTable(summary.tasks ?? [], summary.updatedAt);
  }

  function renderOverviewStats(summary) {
    const stats = [
      { label: "Tasks total", value: summary.taskCounts.total },
      { label: "Running", value: summary.taskCounts.running },
      { label: "Pending", value: summary.taskCounts.pending },
      { label: "Failed", value: summary.taskCounts.failed },
      { label: "Complete", value: summary.taskCounts.complete },
      { label: "Needs review", value: summary.taskCounts.needs_human_review },
      { label: "Batches", value: summary.batchCounts.total },
      { label: "Tokens used", value: formatNumber(summary.tokensUsed) },
      { label: "Est. cost", value: formatCurrency(summary.estimatedCost) },
    ];

    elements.overviewGrid.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const stat of stats) {
      const card = document.createElement("div");
      card.className = "stat-card";

      const label = document.createElement("div");
      label.className = "stat-label";
      label.textContent = stat.label;

      const value = document.createElement("div");
      value.className = "stat-value";
      value.textContent = String(stat.value ?? "—");

      card.append(label, value);
      fragment.appendChild(card);
    }

    elements.overviewGrid.appendChild(fragment);
  }

  function renderHumanReviewList(items) {
    elements.humanReviewBody.innerHTML = "";

    if (!items.length) {
      elements.humanReviewBody.appendChild(buildEmptyItem("No human review items."));
      return;
    }

    for (const item of items) {
      const entry = document.createElement("div");
      entry.className = "overview-item";

      const title = document.createElement("div");
      title.textContent = `${item.id} • ${item.validator}`;

      const reason = document.createElement("div");
      reason.className = "subtext";
      reason.textContent = item.summary ?? item.reason ?? "Requires human review";

      entry.append(title, reason);

      if (item.validator) {
        const link = document.createElement("a");
        link.href = buildValidatorUrl(item.id, item.validator);
        link.textContent = "Open validator report";
        link.target = "_blank";
        link.rel = "noreferrer";
        entry.appendChild(link);
      }

      elements.humanReviewBody.appendChild(entry);
    }
  }

  function renderTopSpendersList(items) {
    elements.topSpendersBody.innerHTML = "";

    if (!items.length) {
      elements.topSpendersBody.appendChild(buildEmptyItem("No spend data yet."));
      return;
    }

    for (const item of items) {
      const entry = document.createElement("div");
      entry.className = "overview-item";

      const title = document.createElement("div");
      title.textContent = item.id;

      const detail = document.createElement("div");
      detail.className = "subtext";
      detail.textContent = `${formatNumber(item.tokensUsed)} tokens • ${formatCurrency(
        item.estimatedCost,
      )}`;

      entry.append(title, detail);
      elements.topSpendersBody.appendChild(entry);
    }
  }

  function renderTaskTable(tasks, updatedAt) {
    elements.tasksTableBody.innerHTML = "";
    elements.tasksCount.textContent = `${tasks.length} tasks`;

    const fragment = document.createDocumentFragment();
    for (const task of tasks) {
      const row = document.createElement("tr");
      row.dataset.taskId = task.id;
      if (task.id === appState.selectedTaskId) {
        row.classList.add("selected");
      }

      const idCell = document.createElement("td");
      idCell.textContent = task.id;

      const statusCell = document.createElement("td");
      const statusChip = document.createElement("span");
      statusChip.className = `status-chip status-${task.status}`;
      statusChip.textContent = task.status;
      statusCell.appendChild(statusChip);

      const attemptsCell = document.createElement("td");
      attemptsCell.textContent = String(task.attempts ?? 0);

      const updatedCell = document.createElement("td");
      const lastSeen = viewState.lastEventByTask.get(task.id) ?? updatedAt;
      updatedCell.textContent = lastSeen ? formatTimestamp(lastSeen) : "—";

      row.append(idCell, statusCell, attemptsCell, updatedCell);
      fragment.appendChild(row);
    }

    elements.tasksTableBody.appendChild(fragment);
  }

  function renderTaskDetail(task) {
    if (!task) {
      elements.taskDetailSubtext.textContent = "No task selected.";
      elements.selectedTaskStatus.textContent = "—";
      elements.selectedTaskStatus.className = "status-pill";
      elements.taskId.textContent = "—";
      elements.taskAttempts.textContent = "—";
      elements.taskBranch.textContent = "—";
      elements.taskThread.textContent = "—";
      return;
    }

    elements.taskDetailSubtext.textContent = `Task ${task.id}`;
    elements.selectedTaskStatus.textContent = task.status;
    elements.selectedTaskStatus.className = `status-pill status-${task.status}`;
    elements.taskId.textContent = task.id;
    elements.taskAttempts.textContent = String(task.attempts ?? 0);
    elements.taskBranch.textContent = task.branch ?? "—";
    elements.taskThread.textContent = task.threadId ?? "—";
  }

  function renderEvents() {
    const taskId = appState.selectedTaskId;
    if (!taskId) {
      elements.eventsList.innerHTML = "";
      elements.eventsMeta.textContent = "Awaiting events.";
      elements.cursorInfo.textContent = "Cursor: —";
      return;
    }

    const key = eventKey(taskId, viewState.typeGlob);
    const events = viewState.eventsByKey.get(key) ?? [];
    const cursor = viewState.cursorByKey.get(key) ?? 0;
    const truncated = viewState.truncatedByKey.get(key);

    elements.eventsList.innerHTML = "";
    if (events.length === 0) {
      elements.eventsList.appendChild(buildEmptyItem("No events yet."));
    } else {
      const fragment = document.createDocumentFragment();
      for (const event of events) {
        fragment.appendChild(buildEventCard(event));
      }
      elements.eventsList.appendChild(fragment);
    }

    const lastEvent = events[events.length - 1];
    const lastEventTime = lastEvent ? formatTimestamp(lastEvent.ts) : "—";
    const tailStatus = isTailPaused() ? "paused" : "polling";
    const truncatedNote = truncated ? " • truncated" : "";

    elements.eventsMeta.textContent = `Last event: ${lastEventTime} • Tail ${tailStatus}${truncatedNote}`;
    elements.cursorInfo.textContent = `Cursor: ${cursor}`;
  }

  function updateEventsStatus() {
    const tailStatus = isTailPaused() ? "paused" : "polling";
    elements.eventsMeta.textContent = `Tail ${tailStatus}.`;
  }

  function isTailPaused() {
    return appState.pollingPaused || !viewState.isActive;
  }


  // =============================================================================
  // UTILITIES
  // =============================================================================

  function hasTarget() {
    return Boolean(appState.projectName && appState.runId);
  }

  function buildTaskEventsUrl(taskId, cursor, typeGlob) {
    const params = new URLSearchParams();
    params.set("cursor", String(cursor));
    if (typeGlob) {
      params.set("typeGlob", typeGlob);
    }

    const query = params.toString();
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/tasks/${encodeURIComponent(taskId)}/events?${query}`;
  }

  function buildDoctorUrl(taskId, attempt) {
    const params = new URLSearchParams();
    if (attempt) {
      params.set("attempt", String(attempt));
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/tasks/${encodeURIComponent(taskId)}/doctor${suffix}`;
  }

  function buildComplianceUrl(taskId) {
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/tasks/${encodeURIComponent(taskId)}/compliance`;
  }

  function buildValidatorUrl(taskId, validatorName) {
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/validators/${encodeURIComponent(validatorName)}/tasks/${encodeURIComponent(taskId)}/report`;
  }

  function eventKey(taskId, typeGlob) {
    const normalizedGlob = typeGlob ? typeGlob : "all";
    return `${taskId}::${normalizedGlob}`;
  }

  function parseEventLine(line) {
    try {
      const parsed = JSON.parse(line);
      return {
        ts: parsed.ts ?? null,
        type: parsed.type ?? "unknown",
        taskId: parsed.task_id ?? null,
        payload: parsed.payload ?? null,
        raw: line,
      };
    } catch (error) {
      return {
        ts: null,
        type: "raw",
        taskId: null,
        payload: { raw: line },
        raw: line,
      };
    }
  }

  function extractEventMessage(event) {
    if (!event.payload || typeof event.payload !== "object") {
      return "";
    }

    const payload = event.payload;
    const candidates = [
      payload.message,
      payload.summary,
      payload.text,
      payload.raw,
      payload.reason,
      payload.note,
      payload.status,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return "";
  }

  function buildEventCard(event) {
    const card = document.createElement("details");
    card.className = "event-card";

    const summary = document.createElement("summary");
    const meta = document.createElement("div");
    meta.className = "event-meta";

    const ts = document.createElement("span");
    ts.className = "event-ts";
    ts.textContent = event.ts ? formatTimestamp(event.ts) : "—";

    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type;

    const message = document.createElement("span");
    message.className = "event-message";
    message.textContent = extractEventMessage(event) || "(no message)";

    meta.append(ts, type, message);
    summary.appendChild(meta);

    const pre = document.createElement("pre");
    pre.textContent = formatJson(event.payload) || event.raw;

    card.append(summary, pre);
    return card;
  }

  function buildEmptyItem(message) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = message;
    return empty;
  }

  function formatTimestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat().format(value);
  }

  function formatCurrency(value) {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatJson(value) {
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  function setDetailError(message) {
    setErrorMessage(elements.detailError, message);
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
}
