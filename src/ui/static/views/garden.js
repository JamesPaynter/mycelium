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

  const WORKSTATION_DEFINITIONS = [
    {
      id: "worker",
      label: "Worker",
      anchor: { xPct: 50, yPct: 18 },
      overflow: { xPct: 68, yPct: 24 },
    },
    {
      id: "researcher",
      label: "Researcher",
      anchor: { xPct: 25, yPct: 38 },
      overflow: { xPct: 9, yPct: 44 },
    },
    {
      id: "coder",
      label: "Coder",
      anchor: { xPct: 75, yPct: 38 },
      overflow: { xPct: 89, yPct: 44 },
    },
    {
      id: "reviewer",
      label: "Reviewer",
      anchor: { xPct: 30, yPct: 78 },
      overflow: { xPct: 14, yPct: 72 },
    },
    {
      id: "artist",
      label: "Artist",
      anchor: { xPct: 70, yPct: 78 },
      overflow: { xPct: 86, yPct: 72 },
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
  const KNOT_POSITION = { xPct: 50, yPct: 65 };
  const KNOT_RADIUS_RANGE = { min: 6, max: 14 };
  const KNOT_RADIUS_SCALE = 0.015;
  const THREAD_CURVE_RANGE = { min: 18, max: 42 };
  const THREAD_TENSION_RANGE = { min: 0.3, max: 0.55 };
  const THREAD_DRIFT_RANGE = { min: -0.08, max: 0.08 };
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
    diorama: null,
    groundLayer: null,
    workstationsLayer: null,
    agentsLayer: null,
    myceliumOverlay: null,
    myceliumThreads: null,
    myceliumKnotGlow: null,
    myceliumKnotCore: null,
    myceliumThreadByTaskId: new Map(),
    myceliumUpdateId: null,
    myceliumResizeObserver: null,
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
    pulseUntilByTaskId: new Map(),
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
    clearMyceliumThreads();
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
    scheduleMyceliumOverlayUpdate();
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

    const { overlay, threads, knotGlow, knotCore } = createMyceliumOverlay();

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

    const { diorama, groundLayer, workstationsLayer, agentsLayer } = createDioramaElements();
    bed.appendChild(diorama);

    garden.append(overlay, landmarks, bed);
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
    viewState.diorama = diorama;
    viewState.groundLayer = groundLayer;
    viewState.workstationsLayer = workstationsLayer;
    viewState.agentsLayer = agentsLayer;
    viewState.myceliumOverlay = overlay;
    viewState.myceliumThreads = threads;
    viewState.myceliumKnotGlow = knotGlow;
    viewState.myceliumKnotCore = knotCore;
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
    startMyceliumResizeObserver();
    scheduleMyceliumOverlayUpdate();
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

  function createDioramaElements() {
    const diorama = document.createElement("div");
    diorama.className = "garden-diorama";

    const groundLayer = document.createElement("div");
    groundLayer.className = "garden-ground-layer";

    for (const definition of WORKSTATION_DEFINITIONS) {
      groundLayer.appendChild(createGroundProp(definition));
    }

    const workstationsLayer = document.createElement("div");
    workstationsLayer.className = "garden-workstations-layer";

    for (const definition of WORKSTATION_DEFINITIONS) {
      workstationsLayer.appendChild(createWorkstation(definition));
    }

    const agentsLayer = document.createElement("div");
    agentsLayer.className = "garden-agents-layer";

    diorama.append(groundLayer, workstationsLayer, agentsLayer);

    return {
      diorama,
      groundLayer,
      workstationsLayer,
      agentsLayer,
    };
  }

  function createGroundProp({ id, anchor }) {
    const prop = document.createElement("div");
    prop.className = "garden-ground-prop";
    prop.dataset.stationId = id;
    prop.style.setProperty("--prop-x", `${anchor.xPct}%`);
    prop.style.setProperty("--prop-y", `${anchor.yPct}%`);
    return prop;
  }

  function createWorkstation({ id, label, anchor, overflow }) {
    const station = document.createElement("div");
    station.className = "garden-workstation";
    station.dataset.stationId = id;
    station.style.setProperty("--station-x", `${anchor.xPct}%`);
    station.style.setProperty("--station-y", `${anchor.yPct}%`);
    station.style.setProperty("--overflow-x", `${overflow.xPct}%`);
    station.style.setProperty("--overflow-y", `${overflow.yPct}%`);

    const node = document.createElement("div");
    node.className = "workstation-node";

    const prop = document.createElement("div");
    prop.className = "workstation-prop";

    const propTop = document.createElement("div");
    propTop.className = "workstation-prop-top";

    const propBase = document.createElement("div");
    propBase.className = "workstation-prop-base";

    const propAccent = document.createElement("div");
    propAccent.className = "workstation-prop-accent";

    prop.append(propTop, propBase, propAccent);

    const labelRow = document.createElement("div");
    labelRow.className = "workstation-label";

    const role = document.createElement("span");
    role.className = "workstation-role";
    role.textContent = label;

    const badge = document.createElement("span");
    badge.className = "workstation-badge";
    badge.textContent = "0";

    labelRow.append(role, badge);

    const indicator = document.createElement("div");
    indicator.className = "workstation-indicator";
    indicator.textContent = "working...";
    indicator.hidden = true;

    node.append(prop, labelRow, indicator);

    const overflowWrap = document.createElement("div");
    overflowWrap.className = "workstation-overflow";
    overflowWrap.hidden = true;

    const overflowPile = document.createElement("div");
    overflowPile.className = "workstation-overflow-pile";

    const overflowLabel = document.createElement("div");
    overflowLabel.className = "workstation-overflow-label";
    overflowLabel.textContent = "+N";

    overflowWrap.append(overflowPile, overflowLabel);

    station.append(node, overflowWrap);
    return station;
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
    viewState.pulseUntilByTaskId.clear();
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
    viewState.pulseUntilByTaskId.set(taskId, Date.now() + PULSE_DURATION_MS);
    scheduleMyceliumOverlayUpdate();

    const timeoutId = window.setTimeout(() => {
      mushroom.classList.remove("pulse");
      viewState.pulseTimeouts.delete(taskId);
      viewState.pulseUntilByTaskId.delete(taskId);
      scheduleMyceliumOverlayUpdate();
    }, PULSE_DURATION_MS);

    viewState.pulseTimeouts.set(taskId, timeoutId);
  }

  function clearPulseTimeout(taskId, mushroom) {
    const timeoutId = viewState.pulseTimeouts.get(taskId);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      viewState.pulseTimeouts.delete(taskId);
    }

    viewState.pulseUntilByTaskId.delete(taskId);
    if (mushroom) {
      mushroom.classList.remove("pulse");
    }
    scheduleMyceliumOverlayUpdate();
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

    scheduleMyceliumOverlayUpdate();
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
    viewState.pulseUntilByTaskId.clear();
  }


  // =============================================================================
  // MYCELIUM OVERLAY
  // =============================================================================

  function createMyceliumOverlay() {
    const overlay = createSvgElement("svg");
    overlay.classList.add("mycelium-overlay");
    overlay.setAttribute("aria-hidden", "true");
    overlay.setAttribute("focusable", "false");
    overlay.setAttribute("preserveAspectRatio", "none");

    const threads = createSvgElement("g");
    threads.classList.add("mycelium-threads");

    const knot = createSvgElement("g");
    knot.classList.add("mycelium-knot");

    const knotGlow = createSvgElement("circle");
    knotGlow.classList.add("mycelium-knot-glow");

    const knotCore = createSvgElement("circle");
    knotCore.classList.add("mycelium-knot-core");

    knot.append(knotGlow, knotCore);
    overlay.append(threads, knot);

    return {
      overlay,
      threads,
      knotGlow,
      knotCore,
    };
  }

  function createSvgElement(tagName) {
    return document.createElementNS("http://www.w3.org/2000/svg", tagName);
  }

  function scheduleMyceliumOverlayUpdate() {
    if (viewState.myceliumUpdateId !== null) {
      return;
    }

    viewState.myceliumUpdateId = window.requestAnimationFrame(() => {
      viewState.myceliumUpdateId = null;
      updateMyceliumOverlay();
    });
  }

  function updateMyceliumOverlay() {
    if (!viewState.garden || !viewState.myceliumOverlay || !viewState.myceliumThreads) {
      return;
    }

    const gardenRect = viewState.garden.getBoundingClientRect();
    if (gardenRect.width <= 0 || gardenRect.height <= 0) {
      return;
    }

    updateMyceliumOverlayBounds(gardenRect);
    const knotPoint = resolveKnotPoint(gardenRect);
    updateMyceliumKnot(knotPoint, gardenRect);

    const runningTasks = getRunningTasks(viewState.latestSummary);
    updateMyceliumThreads(runningTasks, gardenRect, knotPoint);
  }

  function updateMyceliumOverlayBounds(gardenRect) {
    const width = Math.max(1, Math.round(gardenRect.width));
    const height = Math.max(1, Math.round(gardenRect.height));
    viewState.myceliumOverlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  function updateMyceliumKnot(knotPoint, gardenRect) {
    if (!viewState.myceliumKnotGlow || !viewState.myceliumKnotCore) {
      return;
    }

    const radius = resolveKnotRadius(gardenRect);
    const glowRadius = formatSvgNumber(radius * 1.8);
    const coreRadius = formatSvgNumber(radius);
    const x = formatSvgNumber(knotPoint.x);
    const y = formatSvgNumber(knotPoint.y);

    viewState.myceliumKnotGlow.setAttribute("cx", x);
    viewState.myceliumKnotGlow.setAttribute("cy", y);
    viewState.myceliumKnotGlow.setAttribute("r", glowRadius);
    viewState.myceliumKnotCore.setAttribute("cx", x);
    viewState.myceliumKnotCore.setAttribute("cy", y);
    viewState.myceliumKnotCore.setAttribute("r", coreRadius);
  }

  function updateMyceliumThreads(runningTasks, gardenRect, knotPoint) {
    if (!viewState.myceliumThreads) {
      return;
    }

    const runningTaskIds = new Set(runningTasks.map((task) => String(task.id)));
    for (const [taskId, path] of viewState.myceliumThreadByTaskId.entries()) {
      if (runningTaskIds.has(taskId)) {
        continue;
      }
      path.remove();
      viewState.myceliumThreadByTaskId.delete(taskId);
    }

    const now = Date.now();
    for (const task of runningTasks) {
      const taskId = String(task.id);
      const mushroom = viewState.mushroomByTaskId.get(taskId);
      if (!mushroom) {
        continue;
      }

      const targetPoint = resolveElementCenter(mushroom, gardenRect);
      if (!targetPoint) {
        continue;
      }

      const path = getOrCreateMyceliumThread(taskId);
      path.setAttribute("d", buildThreadPath(knotPoint, targetPoint, taskId));
      path.classList.toggle("pulse", isThreadPulseActive(taskId, now));
    }
  }

  function getOrCreateMyceliumThread(taskId) {
    const existing = viewState.myceliumThreadByTaskId.get(taskId);
    if (existing) {
      return existing;
    }

    const path = createSvgElement("path");
    path.classList.add("mycelium-thread");
    path.dataset.taskId = taskId;
    viewState.myceliumThreadByTaskId.set(taskId, path);
    viewState.myceliumThreads.appendChild(path);
    return path;
  }

  function clearMyceliumThreads() {
    for (const path of viewState.myceliumThreadByTaskId.values()) {
      path.remove();
    }
    viewState.myceliumThreadByTaskId.clear();
  }

  function resolveKnotPoint(gardenRect) {
    return {
      x: (gardenRect.width * KNOT_POSITION.xPct) / 100,
      y: (gardenRect.height * KNOT_POSITION.yPct) / 100,
    };
  }

  function resolveKnotRadius(gardenRect) {
    const baseRadius = Math.min(gardenRect.width, gardenRect.height) * KNOT_RADIUS_SCALE;
    return clamp(baseRadius, KNOT_RADIUS_RANGE.min, KNOT_RADIUS_RANGE.max);
  }

  function resolveElementCenter(element, gardenRect) {
    if (!element.isConnected) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - gardenRect.left,
      y: rect.top + rect.height / 2 - gardenRect.top,
    };
  }

  function buildThreadPath(startPoint, endPoint, taskId) {
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const distance = Math.max(1, Math.hypot(dx, dy));

    const baseCurveStrength = scaleBetween(
      THREAD_CURVE_RANGE.min,
      THREAD_CURVE_RANGE.max,
      stableRandom(taskId, "curve"),
    );
    const curveStrength = Math.min(baseCurveStrength, distance * 0.45);
    const curveDirection = stableRandom(taskId, "direction") > 0.5 ? 1 : -1;
    const drift = scaleBetween(
      THREAD_DRIFT_RANGE.min,
      THREAD_DRIFT_RANGE.max,
      stableRandom(taskId, "drift"),
    );
    const tension = scaleBetween(
      THREAD_TENSION_RANGE.min,
      THREAD_TENSION_RANGE.max,
      stableRandom(taskId, "tension"),
    );

    const perpX = -dy / distance;
    const perpY = dx / distance;
    const offsetX = perpX * curveStrength * curveDirection;
    const offsetY = perpY * curveStrength * curveDirection;

    const control1X = startPoint.x + dx * (0.35 + drift) + offsetX;
    const control1Y = startPoint.y + dy * (0.35 + drift) + offsetY;
    const control2X = startPoint.x + dx * (0.65 - drift) - offsetX * tension;
    const control2Y = startPoint.y + dy * (0.65 - drift) - offsetY * tension;

    return [
      "M",
      formatSvgNumber(startPoint.x),
      formatSvgNumber(startPoint.y),
      "C",
      formatSvgNumber(control1X),
      formatSvgNumber(control1Y),
      formatSvgNumber(control2X),
      formatSvgNumber(control2Y),
      formatSvgNumber(endPoint.x),
      formatSvgNumber(endPoint.y),
    ].join(" ");
  }

  function isThreadPulseActive(taskId, now) {
    const pulseUntil = viewState.pulseUntilByTaskId.get(taskId);
    if (!pulseUntil) {
      return false;
    }

    if (pulseUntil <= now) {
      viewState.pulseUntilByTaskId.delete(taskId);
      return false;
    }

    return true;
  }

  function stableRandom(taskId, salt) {
    const seed = hashString(`${taskId}:${salt}`);
    return (Math.abs(seed) % 10000) / 10000;
  }

  function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return hash;
  }

  function scaleBetween(min, max, value) {
    return min + (max - min) * value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatSvgNumber(value) {
    return String(Math.round(value * 10) / 10);
  }

  function startMyceliumResizeObserver() {
    if (!viewState.garden || viewState.myceliumResizeObserver) {
      return;
    }

    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", scheduleMyceliumOverlayUpdate);
      return;
    }

    viewState.myceliumResizeObserver = new ResizeObserver(() => {
      scheduleMyceliumOverlayUpdate();
    });
    viewState.myceliumResizeObserver.observe(viewState.garden);
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
