import { renderTaskInspector } from "./list.js";

// Garden view renderer for the Mycelium UI.
// Purpose: render running tasks as mushrooms and status counts as landmarks.
// Usage: created by app.js and driven via onSummary callbacks.

export function createGardenView({ appState, actions, fetchApi }) {
  const container = document.getElementById("view-garden");


  // =============================================================================
  // CONFIG
  // =============================================================================

  const LANDMARK_DEFINITIONS = [
    {
      key: "spore",
      label: "Spore Basket",
      detail: "Pending",
      countKey: "pending",
    },
    {
      key: "compost",
      label: "Compost Pile",
      detail: "Failed",
      countKey: "failed",
    },
    {
      key: "harvest",
      label: "Harvest Shelf",
      detail: "Complete",
      countKey: "complete",
    },
  ];

  const SLOT_LAYOUT = {
    columnCount: 5,
    xMin: 22,
    xMax: 86,
    yStart: 48,
    rowGap: 8,
  };

  const INITIAL_SLOT_COUNT = 12;
  const SPAWN_ANIMATION_MS = 220;
  const DESPAWN_ANIMATION_MS = 240;
  const EVENTS_POLL_INTERVAL_MS = 2000;
  const MAX_EVENT_BYTES = 32768;
  const PULSE_DURATION_MS = 400;
  const slotColumnPositions = buildSlotColumnPositions();

  const viewState = {
    isActive: true,
    latestSummary: null,
    gardenSlots: buildInitialSlots(INITIAL_SLOT_COUNT),
    slotByTaskId: new Map(),
    taskIdBySlot: new Map(),
    shell: null,
    stage: null,
    garden: null,
    landmarks: null,
    bed: null,
    emptyState: null,
    emptyTitleEl: null,
    emptyCopyEl: null,
    inspectorPanel: null,
    inspector: null,
    isInspectorOpen: false,
    lastSelectedTaskId: null,
    landmarkCountEls: new Map(),
    mushroomByTaskId: new Map(),
    spawnTimeouts: new Map(),
    despawnTimeouts: new Map(),
    pulseTimeouts: new Map(),
    eventCursorByTaskId: new Map(),
    lastEventTypeByTaskId: new Map(),
    lastEventAtByTaskId: new Map(),
    eventsTimerId: null,
    isEventsLoading: false,
  };

  return {
    init,
    reset,
    onSummary,
    setActive,
    setPollingPaused,
  };


  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    if (!container) {
      return;
    }

    renderEmptyState();
  }


  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    viewState.latestSummary = null;
    viewState.lastSelectedTaskId = null;
    resetSlotAllocator();
    clearPendingMushroomTimers();
    clearEventTracking();
    clearMushrooms();
    stopEventsPolling();
    if (viewState.inspector) {
      viewState.inspector.reset();
    }
    setInspectorOpen(false);
    renderEmptyState();
  }

  function setActive(isActive) {
    viewState.isActive = isActive;
    if (!isActive) {
      stopEventsPolling();
      if (viewState.inspector) {
        viewState.inspector.setActive(false);
      }
      return;
    }

    startEventsPolling();
    if (viewState.inspector) {
      viewState.inspector.setActive(viewState.isInspectorOpen);
      viewState.inspector.setPollingPaused();
    }
    if (viewState.latestSummary) {
      renderGarden(viewState.latestSummary);
      return;
    }

    renderEmptyState();
  }

  function setPollingPaused() {
    if (appState.pollingPaused) {
      stopEventsPolling();
      if (viewState.inspector) {
        viewState.inspector.setPollingPaused();
      }
      return;
    }

    startEventsPolling();
    if (viewState.inspector) {
      viewState.inspector.setPollingPaused();
    }
  }


  // =============================================================================
  // SUMMARY
  // =============================================================================

  function onSummary(summary) {
    viewState.latestSummary = summary;
    if (!viewState.isActive) {
      return;
    }

    if (!summary) {
      renderEmptyState();
      return;
    }

    renderGarden(summary);
    startEventsPolling();
  }


  // =============================================================================
  // RENDERING
  // =============================================================================

  function renderEmptyState() {
    const title = appState.projectName
      ? `Project ${appState.projectName} - Run ${appState.runId}`
      : "Waiting for project + run.";
    const copy = appState.projectName
      ? "Garden will sprout mushrooms when tasks are running."
      : "Set a project and run id to see the forest floor.";

    renderGarden(null, {
      emptyTitle: title,
      emptyCopy: copy,
    });
  }

  function renderGarden(summary, options = {}) {
    if (!container) {
      return;
    }

    ensureGardenFrame();

    const runningTasks = getRunningTasks(summary);
    const taskCounts = summary?.taskCounts ?? {};
    const emptyTitle = options.emptyTitle ?? "No running tasks yet.";
    const emptyCopy = options.emptyCopy ?? "Mushrooms appear as tasks move into running.";

    updateLandmarkCounts(taskCounts);
    updateEmptyState(emptyTitle, emptyCopy, runningTasks.length === 0);
    syncSlotAssignments(runningTasks);
    syncMushrooms(runningTasks);
    syncRunningTaskEventTracking(runningTasks);
    syncInspectorSelection(summary);
  }


  // =============================================================================
  // DOM FRAME
  // =============================================================================

  function ensureGardenFrame() {
    if (!container || viewState.garden) {
      return;
    }

    container.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = "garden-shell";

    const stage = document.createElement("div");
    stage.className = "garden-stage";

    const garden = document.createElement("div");
    garden.className = "garden";

    const landmarks = document.createElement("div");
    landmarks.className = "garden-landmarks";

    viewState.landmarkCountEls.clear();
    for (const definition of LANDMARK_DEFINITIONS) {
      const { element, countEl } = createLandmark(definition);
      viewState.landmarkCountEls.set(definition.key, countEl);
      landmarks.appendChild(element);
    }

    const bed = document.createElement("div");
    bed.className = "garden-bed";

    const { emptyState, emptyTitleEl, emptyCopyEl } = createEmptyStateElements();
    bed.appendChild(emptyState);

    garden.append(landmarks, bed);
    stage.appendChild(garden);

    const inspectorPanel = document.createElement("aside");
    inspectorPanel.className = "garden-inspector panel";

    shell.append(stage, inspectorPanel);
    container.appendChild(shell);

    viewState.shell = shell;
    viewState.stage = stage;
    viewState.garden = garden;
    viewState.landmarks = landmarks;
    viewState.bed = bed;
    viewState.emptyState = emptyState;
    viewState.emptyTitleEl = emptyTitleEl;
    viewState.emptyCopyEl = emptyCopyEl;
    viewState.inspectorPanel = inspectorPanel;
    viewState.inspector = renderTaskInspector(inspectorPanel, appState, {
      fetchApi,
      showCloseButton: true,
      onClose: () => {
        setInspectorOpen(false);
      },
    });
    viewState.inspector.init();
    setInspectorOpen(false);
  }

  function createEmptyStateElements() {
    const emptyState = document.createElement("div");
    emptyState.className = "garden-empty";

    const emptyTitleEl = document.createElement("div");
    emptyTitleEl.className = "garden-empty-title";

    const emptyCopyEl = document.createElement("div");
    emptyCopyEl.className = "garden-empty-copy";

    emptyState.append(emptyTitleEl, emptyCopyEl);

    return { emptyState, emptyTitleEl, emptyCopyEl };
  }

  function updateLandmarkCounts(taskCounts) {
    for (const definition of LANDMARK_DEFINITIONS) {
      const countEl = viewState.landmarkCountEls.get(definition.key);
      if (!countEl) {
        continue;
      }
      countEl.textContent = formatCount(taskCounts?.[definition.countKey]);
    }
  }

  function updateEmptyState(title, copy, isEmpty) {
    if (!viewState.emptyState || !viewState.emptyTitleEl || !viewState.emptyCopyEl) {
      return;
    }

    viewState.emptyTitleEl.textContent = title;
    viewState.emptyCopyEl.textContent = copy;
    viewState.emptyState.hidden = !isEmpty;
  }

  function createLandmark({ key, label, detail }) {
    const wrapper = document.createElement("div");
    wrapper.className = `garden-landmark landmark-${key}`;

    const header = document.createElement("div");
    header.className = "landmark-header";

    const icon = document.createElement("div");
    icon.className = "landmark-icon";

    const countEl = document.createElement("div");
    countEl.className = "landmark-count";
    countEl.textContent = "--";

    header.append(icon, countEl);

    const labelEl = document.createElement("div");
    labelEl.className = "landmark-label";
    labelEl.textContent = label;

    const detailEl = document.createElement("div");
    detailEl.className = "landmark-detail";
    detailEl.textContent = detail;

    wrapper.append(header, labelEl, detailEl);
    return { element: wrapper, countEl };
  }


  // =============================================================================
  // SLOT ALLOCATION
  // =============================================================================

  function resetSlotAllocator() {
    viewState.gardenSlots = buildInitialSlots(INITIAL_SLOT_COUNT);
    viewState.slotByTaskId.clear();
    viewState.taskIdBySlot.clear();
  }

  function syncSlotAssignments(runningTasks) {
    const runningTaskIds = new Set(runningTasks.map((task) => String(task.id)));

    for (const [taskId, slotIndex] of viewState.slotByTaskId.entries()) {
      if (!runningTaskIds.has(taskId)) {
        viewState.slotByTaskId.delete(taskId);
        viewState.taskIdBySlot.delete(slotIndex);
      }
    }

    ensureSlotCapacity(runningTaskIds.size);

    for (const task of runningTasks) {
      const taskId = String(task.id);
      if (viewState.slotByTaskId.has(taskId)) {
        continue;
      }

      const slotIndex = findFirstAvailableSlot();
      if (slotIndex === null) {
        continue;
      }

      viewState.slotByTaskId.set(taskId, slotIndex);
      viewState.taskIdBySlot.set(slotIndex, taskId);
    }
  }

  function ensureSlotCapacity(requiredCount) {
    while (viewState.gardenSlots.length < requiredCount) {
      const slotIndex = viewState.gardenSlots.length;
      viewState.gardenSlots.push(buildSlotForIndex(slotIndex));
    }
  }

  function findFirstAvailableSlot() {
    for (let slotIndex = 0; slotIndex < viewState.gardenSlots.length; slotIndex += 1) {
      if (!viewState.taskIdBySlot.has(slotIndex)) {
        return slotIndex;
      }
    }

    return null;
  }

  function buildInitialSlots(count) {
    const slots = [];
    for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
      slots.push(buildSlotForIndex(slotIndex));
    }
    return slots;
  }

  function buildSlotForIndex(slotIndex) {
    const columnIndex = slotIndex % SLOT_LAYOUT.columnCount;
    const rowIndex = Math.floor(slotIndex / SLOT_LAYOUT.columnCount);
    const xPct = slotColumnPositions[columnIndex] ?? 50;
    const yPct = roundToTenth(SLOT_LAYOUT.yStart + rowIndex * SLOT_LAYOUT.rowGap);

    return { xPct, yPct };
  }

  function buildSlotColumnPositions() {
    if (SLOT_LAYOUT.columnCount <= 1) {
      return [roundToTenth((SLOT_LAYOUT.xMin + SLOT_LAYOUT.xMax) / 2)];
    }

    const step = (SLOT_LAYOUT.xMax - SLOT_LAYOUT.xMin) / (SLOT_LAYOUT.columnCount - 1);
    const positions = [];
    for (let index = 0; index < SLOT_LAYOUT.columnCount; index += 1) {
      positions.push(roundToTenth(SLOT_LAYOUT.xMin + step * index));
    }

    return positions;
  }

  function roundToTenth(value) {
    return Math.round(value * 10) / 10;
  }


  // =============================================================================
  // MUSHROOMS
  // =============================================================================

  function syncMushrooms(runningTasks) {
    if (!viewState.bed) {
      return;
    }

    const runningTaskIds = new Set(runningTasks.map((task) => String(task.id)));

    for (const [taskId, mushroom] of viewState.mushroomByTaskId.entries()) {
      if (!runningTaskIds.has(taskId)) {
        startDespawn(taskId, mushroom);
      }
    }

    for (const task of runningTasks) {
      const taskId = String(task.id);
      const mushroom = viewState.mushroomByTaskId.get(taskId);
      const slotIndex = viewState.slotByTaskId.get(taskId);

      if (mushroom) {
        cancelDespawn(taskId, mushroom);
        applySlotPosition(mushroom, slotIndex);
        updateMushroomSelection(mushroom, taskId);
        updateMushroomActivity(mushroom, taskId);
        continue;
      }

      const newMushroom = createMushroom(task, slotIndex);
      viewState.mushroomByTaskId.set(taskId, newMushroom);
      viewState.bed.appendChild(newMushroom);
      updateMushroomActivity(newMushroom, taskId);
      triggerSpawn(taskId, newMushroom);
    }
  }

  function createMushroom(task, slotIndex) {
    const taskId = String(task.id);
    const mushroom = document.createElement("button");
    mushroom.type = "button";
    mushroom.className = "mushroom is-running";
    mushroom.dataset.taskId = taskId;
    mushroom.title = `Task ${taskId} is running`;
    mushroom.setAttribute("aria-label", `Select task ${taskId}`);

    applySlotPosition(mushroom, slotIndex);
    updateMushroomSelection(mushroom, taskId);

    mushroom.addEventListener("click", () => {
      actions.setSelectedTask(taskId);
      updateSelectedMushroom(taskId);
      openInspectorForTask(taskId);
    });

    const float = document.createElement("div");
    float.className = "mushroom-float bob";

    const body = document.createElement("div");
    body.className = "mushroom-body";

    const cap = document.createElement("div");
    cap.className = "mushroom-cap";

    const ribbon = document.createElement("div");
    ribbon.className = "mushroom-ribbon";
    ribbon.textContent = "WORKING";

    const stem = document.createElement("div");
    stem.className = "mushroom-stem";

    body.append(cap, ribbon, stem);

    const label = document.createElement("div");
    label.className = "mushroom-label";
    label.textContent = taskId;

    float.append(body, label);
    mushroom.appendChild(float);

    return mushroom;
  }

  function applySlotPosition(mushroom, slotIndex) {
    if (slotIndex === undefined || slotIndex === null) {
      return;
    }

    const slot = viewState.gardenSlots[slotIndex];
    if (!slot) {
      return;
    }

    mushroom.style.setProperty("--slot-x", `${slot.xPct}%`);
    mushroom.style.setProperty("--slot-y", `${slot.yPct}%`);
    mushroom.style.setProperty("--bob-delay", `${(slotIndex % 6) * 0.12}s`);
  }

  function updateMushroomSelection(mushroom, taskId) {
    const isSelected = String(taskId) === appState.selectedTaskId;
    mushroom.classList.toggle("is-selected", isSelected);
  }

  function startDespawn(taskId, mushroom) {
    if (viewState.despawnTimeouts.has(taskId)) {
      return;
    }

    clearSpawnTimeout(taskId);
    clearPulseTimeout(taskId, mushroom);
    mushroom.classList.remove("spawn");
    mushroom.classList.add("despawn");
    mushroom.setAttribute("aria-hidden", "true");

    const timeoutId = window.setTimeout(() => {
      mushroom.remove();
      viewState.mushroomByTaskId.delete(taskId);
      viewState.despawnTimeouts.delete(taskId);
    }, DESPAWN_ANIMATION_MS);

    viewState.despawnTimeouts.set(taskId, timeoutId);
  }

  function cancelDespawn(taskId, mushroom) {
    const timeoutId = viewState.despawnTimeouts.get(taskId);
    if (!timeoutId) {
      return;
    }

    window.clearTimeout(timeoutId);
    viewState.despawnTimeouts.delete(taskId);
    mushroom.classList.remove("despawn");
    mushroom.removeAttribute("aria-hidden");
  }

  function triggerSpawn(taskId, mushroom) {
    mushroom.classList.add("spawn");

    const timeoutId = window.setTimeout(() => {
      mushroom.classList.remove("spawn");
      viewState.spawnTimeouts.delete(taskId);
    }, SPAWN_ANIMATION_MS);

    viewState.spawnTimeouts.set(taskId, timeoutId);
  }

  function clearSpawnTimeout(taskId) {
    const timeoutId = viewState.spawnTimeouts.get(taskId);
    if (!timeoutId) {
      return;
    }

    window.clearTimeout(timeoutId);
    viewState.spawnTimeouts.delete(taskId);
  }

  function clearMushrooms() {
    if (!viewState.bed) {
      viewState.mushroomByTaskId.clear();
      return;
    }

    for (const mushroom of viewState.mushroomByTaskId.values()) {
      mushroom.remove();
    }

    viewState.mushroomByTaskId.clear();
  }

  function clearPendingMushroomTimers() {
    for (const timeoutId of viewState.spawnTimeouts.values()) {
      window.clearTimeout(timeoutId);
    }

    for (const timeoutId of viewState.despawnTimeouts.values()) {
      window.clearTimeout(timeoutId);
    }

    for (const timeoutId of viewState.pulseTimeouts.values()) {
      window.clearTimeout(timeoutId);
    }

    viewState.spawnTimeouts.clear();
    viewState.despawnTimeouts.clear();
    viewState.pulseTimeouts.clear();
  }

  function updateMushroomActivity(mushroom, taskId) {
    const ribbon = mushroom.querySelector(".mushroom-ribbon");
    if (!ribbon) {
      return;
    }

    const eventType = viewState.lastEventTypeByTaskId.get(taskId);
    const activityLabel = classifyActivityLabel(eventType);
    ribbon.textContent = activityLabel;
    mushroom.title = `Task ${taskId} is running • ${activityLabel}`;
  }

  function triggerPulse(taskId, mushroom) {
    clearPulseTimeout(taskId, mushroom);
    mushroom.classList.remove("pulse");
    void mushroom.offsetWidth;
    mushroom.classList.add("pulse");

    const timeoutId = window.setTimeout(() => {
      mushroom.classList.remove("pulse");
      viewState.pulseTimeouts.delete(taskId);
    }, PULSE_DURATION_MS);

    viewState.pulseTimeouts.set(taskId, timeoutId);
  }

  function clearPulseTimeout(taskId, mushroom) {
    const timeoutId = viewState.pulseTimeouts.get(taskId);
    if (!timeoutId) {
      if (mushroom) {
        mushroom.classList.remove("pulse");
      }
      return;
    }

    window.clearTimeout(timeoutId);
    viewState.pulseTimeouts.delete(taskId);
    if (mushroom) {
      mushroom.classList.remove("pulse");
    }
  }


  // =============================================================================
  // INSPECTOR
  // =============================================================================

  function setInspectorOpen(isOpen) {
    viewState.isInspectorOpen = isOpen;

    if (viewState.inspectorPanel) {
      viewState.inspectorPanel.hidden = !isOpen;
    }

    if (viewState.shell) {
      viewState.shell.classList.toggle("inspector-open", isOpen);
    }

    if (viewState.inspector) {
      viewState.inspector.setActive(isOpen && viewState.isActive);
      viewState.inspector.setPollingPaused();
    }
  }

  function openInspectorForTask(taskId) {
    if (!viewState.inspector) {
      return;
    }

    const selectedTask = findTaskById(viewState.latestSummary, taskId);
    viewState.lastSelectedTaskId = String(taskId);
    setInspectorOpen(true);
    viewState.inspector.onSelectionChanged(selectedTask);
  }

  function syncInspectorSelection(summary) {
    if (!viewState.inspector) {
      return;
    }

    const selectedTaskId = appState.selectedTaskId;
    if (!selectedTaskId) {
      viewState.lastSelectedTaskId = null;
      if (viewState.isInspectorOpen) {
        viewState.inspector.onSelectionChanged(null);
      } else {
        viewState.inspector.updateTaskDetail(null);
      }
      return;
    }

    const normalizedSelectedId = String(selectedTaskId);
    const selectedTask = findTaskById(summary, normalizedSelectedId);
    const hasSelectionChanged = normalizedSelectedId !== viewState.lastSelectedTaskId;
    viewState.lastSelectedTaskId = normalizedSelectedId;

    if (hasSelectionChanged && viewState.isInspectorOpen) {
      viewState.inspector.onSelectionChanged(selectedTask);
      return;
    }

    viewState.inspector.updateTaskDetail(selectedTask);
  }


  // =============================================================================
  // EVENTS POLLING
  // =============================================================================

  function startEventsPolling() {
    if (viewState.eventsTimerId !== null) {
      return;
    }
    if (!viewState.isActive) {
      return;
    }
    if (appState.pollingPaused) {
      return;
    }
    if (!hasTarget()) {
      return;
    }
    if (typeof fetchApi !== "function") {
      return;
    }

    void fetchRunningTaskEvents();
    viewState.eventsTimerId = window.setInterval(() => {
      void fetchRunningTaskEvents();
    }, EVENTS_POLL_INTERVAL_MS);
  }

  function stopEventsPolling() {
    if (viewState.eventsTimerId === null) {
      return;
    }

    window.clearInterval(viewState.eventsTimerId);
    viewState.eventsTimerId = null;
  }

  async function fetchRunningTaskEvents() {
    if (viewState.isEventsLoading) {
      return;
    }
    if (!viewState.latestSummary) {
      return;
    }

    const runningTasks = getRunningTasks(viewState.latestSummary);
    if (runningTasks.length === 0) {
      return;
    }

    viewState.isEventsLoading = true;
    try {
      const requests = runningTasks.map((task) => fetchTaskEventsForTask(String(task.id)));
      await Promise.allSettled(requests);
    } finally {
      viewState.isEventsLoading = false;
    }
  }

  async function fetchTaskEventsForTask(taskId) {
    const cursor = viewState.eventCursorByTaskId.get(taskId) ?? 0;
    const result = await fetchApi(buildTaskEventsUrl(taskId, cursor));
    const nextCursor = result.nextCursor ?? cursor;
    viewState.eventCursorByTaskId.set(taskId, nextCursor);

    if (!Array.isArray(result.lines) || result.lines.length === 0) {
      return;
    }

    const parsedEvents = result.lines.map(parseEventLine);
    const lastEvent = parsedEvents[parsedEvents.length - 1] ?? null;
    if (!lastEvent) {
      return;
    }

    viewState.lastEventTypeByTaskId.set(taskId, lastEvent.type);
    const lastEventAt = resolveEventTimestamp(parsedEvents);
    if (lastEventAt !== null) {
      viewState.lastEventAtByTaskId.set(taskId, lastEventAt);
    }

    const mushroom = viewState.mushroomByTaskId.get(taskId);
    if (!mushroom) {
      return;
    }

    updateMushroomActivity(mushroom, taskId);
    triggerPulse(taskId, mushroom);
  }

  function syncRunningTaskEventTracking(runningTasks) {
    const runningTaskIds = new Set(runningTasks.map((task) => String(task.id)));
    const trackedTaskIds = new Set(viewState.eventCursorByTaskId.keys());

    for (const taskId of trackedTaskIds) {
      if (runningTaskIds.has(taskId)) {
        continue;
      }

      viewState.eventCursorByTaskId.delete(taskId);
      viewState.lastEventTypeByTaskId.delete(taskId);
      viewState.lastEventAtByTaskId.delete(taskId);
      const mushroom = viewState.mushroomByTaskId.get(taskId);
      clearPulseTimeout(taskId, mushroom);
    }
  }

  function clearEventTracking() {
    viewState.eventCursorByTaskId.clear();
    viewState.lastEventTypeByTaskId.clear();
    viewState.lastEventAtByTaskId.clear();
  }


  // =============================================================================
  // UTILITIES
  // =============================================================================

  function getRunningTasks(summary) {
    if (!summary?.tasks?.length) {
      return [];
    }

    return summary.tasks
      .filter((task) => task.status === "running")
      .sort((first, second) => String(first.id).localeCompare(String(second.id)));
  }

  function findTaskById(summary, taskId) {
    if (!summary?.tasks?.length || taskId === null || taskId === undefined) {
      return null;
    }

    const normalizedId = String(taskId);
    return summary.tasks.find((task) => String(task.id) === normalizedId) ?? null;
  }

  function formatCount(value) {
    if (value === null || value === undefined) {
      return "--";
    }

    return String(value);
  }

  function updateSelectedMushroom(taskId) {
    if (!container) {
      return;
    }

    const normalizedTaskId = String(taskId);
    const mushroomButtons = container.querySelectorAll(".mushroom");
    for (const button of mushroomButtons) {
      const isSelected = button.dataset.taskId === normalizedTaskId;
      button.classList.toggle("is-selected", isSelected);
    }
  }

  function hasTarget() {
    return Boolean(appState.projectName && appState.runId);
  }

  function buildTaskEventsUrl(taskId, cursor) {
    const params = new URLSearchParams();
    params.set("cursor", String(cursor));
    params.set("maxBytes", String(MAX_EVENT_BYTES));

    const query = params.toString();
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/tasks/${encodeURIComponent(taskId)}/events?${query}`;
  }

  function parseEventLine(line) {
    if (!line) {
      return { type: "raw", ts: null };
    }

    try {
      const parsed = JSON.parse(line);
      return {
        type: parsed.type ?? "unknown",
        ts: parsed.ts ?? null,
      };
    } catch (error) {
      return {
        type: "raw",
        ts: null,
      };
    }
  }

  function resolveEventTimestamp(parsedEvents) {
    for (let index = parsedEvents.length - 1; index >= 0; index -= 1) {
      const candidate = parsedEvents[index];
      const parsed = parseTimestamp(candidate?.ts);
      if (parsed !== null) {
        return parsed;
      }
    }

    return Date.now();
  }

  function parseTimestamp(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return null;
    }

    return parsed;
  }

  function classifyActivityLabel(eventType) {
    const normalized = eventType ? String(eventType).toLowerCase() : "";
    if (!normalized) {
      return "WORKING";
    }

    if (matchesTypePrefix(normalized, "bootstrap")) {
      return "BOOTSTRAP";
    }
    if (matchesTypePrefix(normalized, "doctor")) {
      return "DOCTOR";
    }
    if (matchesTypePrefix(normalized, "git")) {
      return "GIT";
    }
    if (matchesTypePrefix(normalized, "validator") || matchesTypePrefix(normalized, "test")) {
      return "TESTING";
    }
    if (
      matchesTypePrefix(normalized, "codex") ||
      matchesTypePrefix(normalized, "llm") ||
      matchesTypePrefix(normalized, "agent")
    ) {
      return "THINKING";
    }

    return "WORKING";
  }

  function matchesTypePrefix(eventType, prefix) {
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
}
