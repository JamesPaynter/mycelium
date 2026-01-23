// List view renderer for the Mycelium UI.
// Purpose: render run summary, task table, and task detail/events for the List view.
// Usage: created by app.js and driven via onSummary / onSelectionChanged callbacks.

export function createListView({ appState, actions, fetchApi }) {
  const viewState = {
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
  };

  const inspectorContainer = document.querySelector("#view-list .detail-panel");
  const inspector = renderTaskInspector(inspectorContainer, appState, { fetchApi });

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
    inspector.init();
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
  }


  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    inspector.reset();
    renderEmptyState();
  }

  function setActive(isActive) {
    viewState.isActive = isActive;
    inspector.setActive(isActive);
  }

  function setPollingPaused() {
    inspector.setPollingPaused();
  }

  function refresh() {
    if (!viewState.isActive) {
      return Promise.resolve();
    }

    return inspector.refresh();
  }


  // =============================================================================
  // SUMMARY + SELECTION
  // =============================================================================

  function onSummary(summary) {
    if (!summary) {
      renderEmptyState();
      inspector.reset();
      return;
    }

    renderSummary(summary);
    ensureTaskSelection(summary);
    syncInspectorSummary(summary);
  }

  function onSelectionChanged(taskId) {
    const tasks = appState.summary?.tasks ?? [];
    const task = tasks.find((item) => item.id === taskId) ?? null;
    inspector.onSelectionChanged(task);
    renderTaskTable(tasks, appState.summary?.updatedAt ?? null);
  }

  function ensureTaskSelection(summary) {
    const tasks = summary.tasks ?? [];
    if (!tasks.length) {
      actions.setSelectedTask(null);
      inspector.updateTaskDetail(null);
      return;
    }

    const selectedExists = tasks.some((task) => task.id === appState.selectedTaskId);
    if (selectedExists) {
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

  function syncInspectorSummary(summary) {
    const tasks = summary.tasks ?? [];
    const selectedTask = tasks.find((task) => task.id === appState.selectedTaskId) ?? null;
    inspector.updateTaskDetail(selectedTask);
  }

  function selectTask(taskId) {
    actions.setSelectedTask(taskId);
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
        link.href = buildValidatorUrl(appState, item.id, item.validator);
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
      const lastSeen = inspector.getLastEventTimestamp(task.id) ?? updatedAt;
      updatedCell.textContent = lastSeen ? formatTimestamp(lastSeen) : "—";

      row.append(idCell, statusCell, attemptsCell, updatedCell);
      fragment.appendChild(row);
    }

    elements.tasksTableBody.appendChild(fragment);
  }
}


// =============================================================================
// TASK INSPECTOR
// =============================================================================

export function renderTaskInspector(container, appState, options = {}) {
  const { fetchApi, showCloseButton = false, onClose } = options;
  const EVENTS_POLL_INTERVAL_MS = 2000;
  const MAX_EVENTS_PER_VIEW = 240;

  if (!container) {
    return buildNoopInspector();
  }

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

  const elements = buildInspectorFrame();

  return {
    init,
    reset,
    onSelectionChanged,
    updateTaskDetail,
    setActive,
    setPollingPaused,
    refresh,
    getLastEventTimestamp,
  };


  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    wireControls();
    renderEmptyState();
  }

  function wireControls() {
    elements.typeFilterInput.addEventListener("change", () => {
      applyTypeFilter(elements.typeFilterInput.value.trim());
    });

    elements.typeFilterInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        applyTypeFilter(elements.typeFilterInput.value.trim());
      }
    });

    for (const button of elements.filterButtons) {
      button.addEventListener("click", () => {
        applyTypeFilter(button.dataset.filter ?? "");
      });
    }

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

    if (elements.closeButton && typeof onClose === "function") {
      elements.closeButton.addEventListener("click", () => {
        onClose();
      });
    }
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

  function getLastEventTimestamp(taskId) {
    return viewState.lastEventByTask.get(taskId) ?? null;
  }


  // =============================================================================
  // SELECTION + FILTERS
  // =============================================================================

  function onSelectionChanged(task) {
    updateTaskDetail(task);
    updateEventsStatus();
    renderEvents();
    startEventsPolling();
  }

  function updateTaskDetail(task) {
    renderTaskDetail(task);
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
    if (!hasTarget()) return;
    if (typeof fetchApi !== "function") return;

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
    if (typeof fetchApi !== "function") return;

    const taskId = appState.selectedTaskId;
    const key = eventKey(taskId, viewState.typeGlob);
    const cursor = viewState.cursorByKey.get(key) ?? 0;

    viewState.isEventsLoading = true;
    try {
      const result = await fetchApi(buildTaskEventsUrl(appState, taskId, cursor, viewState.typeGlob));
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
      const result = await fetchApi(buildDoctorUrl(appState, taskId, attemptParam));
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
      const result = await fetchApi(buildComplianceUrl(appState, taskId));
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
      const result = await fetchApi(buildValidatorUrl(appState, taskId, validatorName));
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
  // DOM FRAME
  // =============================================================================

  function buildInspectorFrame() {
    container.classList.add("task-inspector");
    container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "panel-header";

    const titleBlock = document.createElement("div");

    const title = document.createElement("h2");
    title.textContent = "Task Detail";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    subtext.textContent = "No task selected.";

    titleBlock.append(title, subtext);

    const meta = document.createElement("div");
    meta.className = "panel-meta";

    let closeButton = null;
    if (showCloseButton) {
      closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "drawer-close";
      closeButton.setAttribute("aria-label", "Close inspector");
      closeButton.textContent = "✕";
      meta.appendChild(closeButton);
    }

    const status = document.createElement("span");
    status.className = "status-pill";
    status.textContent = "—";

    meta.appendChild(status);

    header.append(titleBlock, meta);

    const body = document.createElement("div");
    body.className = "detail-body";

    const detailMeta = document.createElement("div");
    detailMeta.className = "detail-meta";

    const taskIdEntry = createMetaEntry("Task ID");
    const attemptsEntry = createMetaEntry("Attempts");
    const branchEntry = createMetaEntry("Branch");
    const threadEntry = createMetaEntry("Thread");

    detailMeta.append(
      taskIdEntry.wrapper,
      attemptsEntry.wrapper,
      branchEntry.wrapper,
      threadEntry.wrapper,
    );

    const filters = document.createElement("div");
    filters.className = "filters";

    const filterField = document.createElement("div");
    filterField.className = "field wide";

    const filterLabel = document.createElement("label");
    const filterInput = document.createElement("input");
    const filterInputId = nextInspectorId("type-filter");
    filterLabel.textContent = "Type filter (typeGlob)";
    filterLabel.setAttribute("for", filterInputId);
    filterInput.id = filterInputId;
    filterInput.type = "text";
    filterInput.placeholder = "doctor.*";
    filterInput.autocomplete = "off";

    filterField.append(filterLabel, filterInput);

    const filterButtons = document.createElement("div");
    filterButtons.className = "filter-buttons";
    const filterButtonList = buildFilterButtons([
      { label: "All", value: "" },
      { label: "Bootstrap", value: "bootstrap.*" },
      { label: "Doctor", value: "doctor.*" },
      { label: "Git", value: "git.*" },
    ]);
    for (const button of filterButtonList) {
      filterButtons.appendChild(button);
    }

    const filterMeta = document.createElement("div");
    filterMeta.className = "filter-meta";

    const cursorInfo = document.createElement("span");
    cursorInfo.textContent = "Cursor: —";

    const resetCursorButton = document.createElement("button");
    resetCursorButton.type = "button";
    resetCursorButton.className = "btn tiny ghost";
    resetCursorButton.textContent = "Reset cursor";

    filterMeta.append(cursorInfo, resetCursorButton);

    filters.append(filterField, filterButtons, filterMeta);

    const eventsPanel = document.createElement("div");
    eventsPanel.className = "events-panel";

    const eventsHeader = document.createElement("div");
    eventsHeader.className = "events-header";

    const eventsTitle = document.createElement("h3");
    eventsTitle.textContent = "Event Tail";

    const eventsMeta = document.createElement("div");
    eventsMeta.className = "events-meta";
    eventsMeta.textContent = "Awaiting events.";

    eventsHeader.append(eventsTitle, eventsMeta);

    const eventsList = document.createElement("div");
    eventsList.className = "events-list";

    eventsPanel.append(eventsHeader, eventsList);

    const diagnostics = document.createElement("div");
    diagnostics.className = "diagnostics";

    const diagnosticsTitle = document.createElement("h3");
    diagnosticsTitle.textContent = "Diagnostics";

    const diagGrid = document.createElement("div");
    diagGrid.className = "diag-grid";

    const doctorCard = buildDoctorCard();
    const complianceCard = buildComplianceCard();
    const validatorCard = buildValidatorCard();

    diagGrid.append(doctorCard.wrapper, complianceCard.wrapper, validatorCard.wrapper);
    diagnostics.append(diagnosticsTitle, diagGrid);

    const detailError = document.createElement("div");
    detailError.className = "error-banner hidden";

    body.append(detailMeta, filters, eventsPanel, diagnostics, detailError);
    container.append(header, body);

    return {
      taskDetailSubtext: subtext,
      selectedTaskStatus: status,
      taskId: taskIdEntry.value,
      taskAttempts: attemptsEntry.value,
      taskBranch: branchEntry.value,
      taskThread: threadEntry.value,
      typeFilterInput: filterInput,
      filterButtons: filterButtonList,
      cursorInfo,
      resetCursorButton,
      eventsMeta,
      eventsList,
      doctorAttemptInput: doctorCard.attemptInput,
      doctorFetchButton: doctorCard.fetchButton,
      doctorOutput: doctorCard.output,
      complianceFetchButton: complianceCard.fetchButton,
      complianceOutput: complianceCard.output,
      validatorInput: validatorCard.nameInput,
      validatorFetchButton: validatorCard.fetchButton,
      validatorOutput: validatorCard.output,
      detailError,
      closeButton,
    };
  }

  function createMetaEntry(labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "meta-item";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = labelText;

    const value = document.createElement("span");
    value.className = "value";
    value.textContent = "—";

    wrapper.append(label, value);

    return { wrapper, value };
  }

  function buildFilterButtons(definitions) {
    const buttons = [];
    for (const definition of definitions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small";
      button.textContent = definition.label;
      button.dataset.filter = definition.value;
      buttons.push(button);
    }
    return buttons;
  }

  function buildDoctorCard() {
    const wrapper = document.createElement("div");
    wrapper.className = "diag-card";

    const header = document.createElement("div");
    header.className = "diag-header";

    const headerText = document.createElement("div");

    const title = document.createElement("h4");
    title.textContent = "Doctor";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    subtext.textContent = "Latest doctor snippet";

    headerText.append(title, subtext);

    const controls = document.createElement("div");
    controls.className = "diag-controls";

    const attemptInput = document.createElement("input");
    attemptInput.type = "number";
    attemptInput.min = "1";
    attemptInput.placeholder = "attempt";

    const fetchButton = document.createElement("button");
    fetchButton.type = "button";
    fetchButton.className = "btn small";
    fetchButton.textContent = "Fetch";

    controls.append(attemptInput, fetchButton);
    header.append(headerText, controls);

    const output = document.createElement("pre");
    output.className = "diag-output";
    output.textContent = "No data.";

    wrapper.append(header, output);

    return {
      wrapper,
      attemptInput,
      fetchButton,
      output,
    };
  }

  function buildComplianceCard() {
    const wrapper = document.createElement("div");
    wrapper.className = "diag-card";

    const header = document.createElement("div");
    header.className = "diag-header";

    const headerText = document.createElement("div");

    const title = document.createElement("h4");
    title.textContent = "Compliance";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    subtext.textContent = "Task compliance report";

    headerText.append(title, subtext);

    const fetchButton = document.createElement("button");
    fetchButton.type = "button";
    fetchButton.className = "btn small";
    fetchButton.textContent = "Fetch";

    header.append(headerText, fetchButton);

    const output = document.createElement("pre");
    output.className = "diag-output";
    output.textContent = "No data.";

    wrapper.append(header, output);

    return {
      wrapper,
      fetchButton,
      output,
    };
  }

  function buildValidatorCard() {
    const wrapper = document.createElement("div");
    wrapper.className = "diag-card";

    const header = document.createElement("div");
    header.className = "diag-header";

    const headerText = document.createElement("div");

    const title = document.createElement("h4");
    title.textContent = "Validator";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    subtext.textContent = "Validator report";

    headerText.append(title, subtext);

    const controls = document.createElement("div");
    controls.className = "diag-controls";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "validator name";
    nameInput.autocomplete = "off";

    const fetchButton = document.createElement("button");
    fetchButton.type = "button";
    fetchButton.className = "btn small";
    fetchButton.textContent = "Fetch";

    controls.append(nameInput, fetchButton);
    header.append(headerText, controls);

    const output = document.createElement("pre");
    output.className = "diag-output";
    output.textContent = "No data.";

    wrapper.append(header, output);

    return {
      wrapper,
      nameInput,
      fetchButton,
      output,
    };
  }


  // =============================================================================
  // UTILITIES
  // =============================================================================

  function hasTarget() {
    return Boolean(appState.projectName && appState.runId);
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

  function setDetailError(message) {
    setErrorMessage(elements.detailError, message);
  }
}


// =============================================================================
// SHARED UTILITIES
// =============================================================================

let inspectorIdCounter = 0;

function nextInspectorId(prefix) {
  inspectorIdCounter += 1;
  return `${prefix}-${inspectorIdCounter}`;
}

function buildNoopInspector() {
  return {
    init() {},
    reset() {},
    onSelectionChanged() {},
    updateTaskDetail() {},
    setActive() {},
    setPollingPaused() {},
    refresh() {
      return Promise.resolve();
    },
    getLastEventTimestamp() {
      return null;
    },
  };
}

function buildTaskEventsUrl(appState, taskId, cursor, typeGlob) {
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

function buildDoctorUrl(appState, taskId, attempt) {
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

function buildComplianceUrl(appState, taskId) {
  return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
    appState.runId,
  )}/tasks/${encodeURIComponent(taskId)}/compliance`;
}

function buildValidatorUrl(appState, taskId, validatorName) {
  return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
    appState.runId,
  )}/validators/${encodeURIComponent(validatorName)}/tasks/${encodeURIComponent(taskId)}/report`;
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
