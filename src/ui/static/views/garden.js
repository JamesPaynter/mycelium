import { renderTaskInspector } from "./list.js";

// Garden view renderer for the Mycelium UI.
// Purpose: render running tasks as mushrooms and status counts as landmarks.
// Usage: created by app.js and driven via onSummary callbacks.

const ACTIVE_TASK_STATUSES = new Set(["running", "needs_review", "needs_rescope"]);
const TERMINAL_TASK_STATUSES = new Set(["failed", "complete"]);
const MAX_VISIBLE_AGENTS = 20;

function isTaskActiveStatus(status) {
  return ACTIVE_TASK_STATUSES.has(status);
}

function isTaskTerminalStatus(status) {
  return TERMINAL_TASK_STATUSES.has(status);
}

function deriveWorkstationId(status, role) {
  if (status === "needs_review") {
    return "reviewer";
  }
  if (status === "needs_rescope") {
    return "researcher";
  }
  if (status !== "running") {
    return null;
  }

  if (role === "researcher") {
    return "researcher";
  }
  if (role === "coder") {
    return "coder";
  }
  if (role === "reviewer") {
    return "reviewer";
  }
  if (role === "artist") {
    return "artist";
  }
  if (role === "worker") {
    return "worker";
  }

  return "worker";
}

function compareVisibilityPriority(first, second) {
  if (first.tokensUsed !== second.tokensUsed) {
    return second.tokensUsed - first.tokensUsed;
  }
  if (first.cost !== second.cost) {
    return second.cost - first.cost;
  }
  if (first.startedAt !== second.startedAt) {
    return first.startedAt - second.startedAt;
  }

  return String(first.id).localeCompare(String(second.id));
}

export function snapshotDiff(prevById, nextTasks) {
  const nextById = new Map();
  for (const task of nextTasks) {
    nextById.set(task.id, task);
  }

  const added = new Set();
  const removed = new Set();
  const changed = new Set();
  const changesById = new Map();

  const allIds = new Set([...prevById.keys(), ...nextById.keys()]);
  for (const taskId of allIds) {
    const prevTask = prevById.get(taskId) ?? null;
    const nextTask = nextById.get(taskId) ?? null;

    if (!prevTask && nextTask) {
      added.add(taskId);
      changed.add(taskId);
      changesById.set(taskId, {
        statusChanged: true,
        roleChanged: true,
        workstationChanged: true,
        becameTerminal: isTaskTerminalStatus(nextTask.status),
        becameActive: isTaskActiveStatus(nextTask.status),
      });
      continue;
    }

    if (prevTask && !nextTask) {
      removed.add(taskId);
      changed.add(taskId);
      continue;
    }

    if (!prevTask || !nextTask) {
      continue;
    }

    const statusChanged = prevTask.status !== nextTask.status;
    const roleChanged = prevTask.role !== nextTask.role;
    const workstationChanged = prevTask.workstationId !== nextTask.workstationId;
    const becameTerminal =
      !isTaskTerminalStatus(prevTask.status) && isTaskTerminalStatus(nextTask.status);
    const becameActive =
      !isTaskActiveStatus(prevTask.status) && isTaskActiveStatus(nextTask.status);

    if (statusChanged || roleChanged || workstationChanged || becameTerminal || becameActive) {
      changed.add(taskId);
      changesById.set(taskId, {
        statusChanged,
        roleChanged,
        workstationChanged,
        becameTerminal,
        becameActive,
      });
    }
  }

  return {
    nextById,
    added,
    removed,
    changed,
    changesById,
  };
}

export function selectVisibleTaskIds({
  candidates,
  pinnedTaskIds,
  maxVisible = MAX_VISIBLE_AGENTS,
}) {
  const visible = new Set();
  if (!Array.isArray(candidates) || candidates.length === 0 || maxVisible <= 0) {
    return visible;
  }

  const safePinned = pinnedTaskIds ?? new Set();
  const candidatesById = new Map(candidates.map((task) => [task.id, task]));

  const pinnedTasks = [];
  for (const taskId of safePinned) {
    const task = candidatesById.get(taskId);
    if (task) {
      pinnedTasks.push(task);
    }
  }

  pinnedTasks.sort(compareVisibilityPriority);
  for (const task of pinnedTasks) {
    if (visible.size >= maxVisible) {
      return visible;
    }
    visible.add(task.id);
  }

  const remainingTasks = candidates.filter((task) => !visible.has(task.id));
  remainingTasks.sort(compareVisibilityPriority);
  for (const task of remainingTasks) {
    if (visible.size >= maxVisible) {
      break;
    }
    visible.add(task.id);
  }

  return visible;
}

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

  const MAX_WORKSTATION_SLOTS = 4;
  const WORKSTATION_SLOT_POSITIONS = {
    worker: [
      { xPct: 38, yPct: 30 },
      { xPct: 46, yPct: 32 },
      { xPct: 54, yPct: 32 },
      { xPct: 62, yPct: 30 },
    ],
    researcher: [
      { xPct: 17, yPct: 50 },
      { xPct: 25, yPct: 52 },
      { xPct: 33, yPct: 50 },
      { xPct: 25, yPct: 58 },
    ],
    coder: [
      { xPct: 67, yPct: 50 },
      { xPct: 75, yPct: 52 },
      { xPct: 83, yPct: 50 },
      { xPct: 75, yPct: 58 },
    ],
    reviewer: [
      { xPct: 22, yPct: 64 },
      { xPct: 30, yPct: 62 },
      { xPct: 38, yPct: 64 },
      { xPct: 30, yPct: 56 },
    ],
    artist: [
      { xPct: 62, yPct: 64 },
      { xPct: 70, yPct: 62 },
      { xPct: 78, yPct: 64 },
      { xPct: 70, yPct: 56 },
    ],
  };

  const SPAWN_ANIMATION_MS = 220;
  const DESPAWN_ANIMATION_MS = 240;
  const EVENTS_POLL_INTERVAL_MS = 2000;
  const MAX_EVENT_BYTES = 32768;
  const PULSE_DURATION_MS = 400;
  const END_GRACE_MS = 2000;
  const TICK_INTERVAL_MS = 500;
  const MOVE_STEP_COUNT = 4;
  const MOVE_LANE_Y_PCT = 55;
  const TERMINAL_POSE_TICKS = { min: 1, max: 2 };
  const KNOT_POSITION = { xPct: 50, yPct: 65 };
  const KNOT_RADIUS_RANGE = { min: 6, max: 14 };
  const KNOT_RADIUS_SCALE = 0.015;
  const THREAD_CURVE_RANGE = { min: 18, max: 42 };
  const THREAD_TENSION_RANGE = { min: 0.3, max: 0.55 };
  const THREAD_DRIFT_RANGE = { min: -0.08, max: 0.08 };

  const viewState = {
    isActive: true,
    latestSummary: null,
    normalizedTasks: [],
    normalizedTaskById: new Map(),
    prevSnapshotById: new Map(),
    visibleTaskIds: new Set(),
    transitionsByTaskId: new Map(),
    transitionTimerId: null,
    reservedSlotsByStation: new Map(),
    terminalGraceUntilByTaskId: new Map(),
    terminalStationByTaskId: new Map(),
    firstSeenAtByTaskId: new Map(),
    workstationElementsById: new Map(),
    workstationTaskIdsById: new Map(),
    slotAssignmentsByStation: new Map(),
    taskIdByStationSlot: new Map(),
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
    lastEmptyStateKey: "",
    inspectorPanel: null,
    inspector: null,
    isInspectorOpen: false,
    lastSelectedTaskId: null,
    selectedWorkstationId: null,
    landmarkCountEls: new Map(),
    failureMarkerTimeoutsByStation: new Map(),
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
    setSelectedWorkstation(null);
    viewState.normalizedTasks = [];
    viewState.normalizedTaskById.clear();
    viewState.prevSnapshotById.clear();
    viewState.visibleTaskIds.clear();
    clearTransitions();
    clearTerminalGrace();
    viewState.firstSeenAtByTaskId.clear();
    viewState.workstationTaskIdsById.clear();
    viewState.lastEmptyStateKey = "";
    resetWorkstationSlots();
    clearPendingMushroomTimers();
    clearFailureMarkers();
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
      stopTransitionTimer();
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
      if (viewState.transitionsByTaskId.size > 0) {
        startTransitionTimer();
      }
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

    const normalizedTasks = normalizeTaskSnapshots(summary);
    const previousSnapshotById = viewState.prevSnapshotById;
    const diff = snapshotDiff(previousSnapshotById, normalizedTasks);
    viewState.normalizedTasks = normalizedTasks;
    viewState.normalizedTaskById = diff.nextById;
    viewState.prevSnapshotById = diff.nextById;

    const now = Date.now();
    pruneTerminalGrace(now);
    updateTerminalGrace(diff, previousSnapshotById, now);
    clearTransitionsForRemovedTasks(diff);

    const runningTasks = getRunningTasks(normalizedTasks);
    const activeTasks = normalizedTasks.filter((task) => isTaskActiveStatus(task.status));
    const terminalGraceTasks = getTerminalGraceTasks(normalizedTasks, now);
    const candidates = [...activeTasks, ...terminalGraceTasks];
    const pinnedTaskIds = buildPinnedTaskIds(diff, now);
    const visibleTaskIds = selectVisibleTaskIds({
      candidates,
      pinnedTaskIds,
      maxVisible: MAX_VISIBLE_AGENTS,
    });
    const visibleSetChanged = !areSetsEqual(visibleTaskIds, viewState.visibleTaskIds);
    const hasMeaningfulChanges = diff.changed.size > 0;
    const hasActiveTransitions = viewState.transitionsByTaskId.size > 0;

    const taskCounts = summary?.taskCounts ?? {};
    const emptyTitle = options.emptyTitle ?? "No running tasks yet.";
    const emptyCopy = options.emptyCopy ?? "Mushrooms appear as tasks move into running.";
    const emptyStateKey = `${emptyTitle}|${emptyCopy}`;
    const emptyStateChanged =
      runningTasks.length === 0 && emptyStateKey !== viewState.lastEmptyStateKey;

    if (
      !hasActiveTransitions &&
      !hasMeaningfulChanges &&
      !visibleSetChanged &&
      !emptyStateChanged
    ) {
      return;
    }

    viewState.visibleTaskIds = visibleTaskIds;
    viewState.lastEmptyStateKey = emptyStateKey;

    syncSelectedMushroomVisibility(visibleTaskIds, diff.nextById);

    const tasksByStation = mapTasksToWorkstations(activeTasks);
    const slotCandidatesByStation = mapTasksToWorkstations(candidates);
    const originSlotsByTaskId = reserveMoveOrigins(diff, previousSnapshotById);

    updateLandmarkCounts(taskCounts);
    updateEmptyState(emptyTitle, emptyCopy, runningTasks.length === 0);
    syncWorkstationSlots(slotCandidatesByStation, visibleTaskIds);
    buildTransitionsFromDiff(diff, previousSnapshotById, originSlotsByTaskId, now);
    const slottedVisibleTasks = buildSlottedVisibleTasks(slotCandidatesByStation, visibleTaskIds);
    syncWorkstationIndicators(tasksByStation, visibleTaskIds);
    syncMushrooms(slottedVisibleTasks);
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

    const { diorama, groundLayer, workstationsLayer, agentsLayer, workstationElementsById } =
      createDioramaElements();
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
    viewState.workstationElementsById = workstationElementsById;
    syncWorkstationSelection();
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

    const workstationElementsById = new Map();
    for (const definition of WORKSTATION_DEFINITIONS) {
      const stationElements = createWorkstation(definition);
      workstationElementsById.set(definition.id, stationElements);
      workstationsLayer.appendChild(stationElements.element);
    }

    const agentsLayer = document.createElement("div");
    agentsLayer.className = "garden-agents-layer";

    diorama.append(groundLayer, workstationsLayer, agentsLayer);

    return {
      diorama,
      groundLayer,
      workstationsLayer,
      agentsLayer,
      workstationElementsById,
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

    const node = document.createElement("button");
    node.type = "button";
    node.className = "workstation-node";
    node.setAttribute("aria-label", `Select ${label} workstation`);
    node.setAttribute("aria-pressed", "false");
    node.title = buildWorkstationTitle(label, 0);
    node.addEventListener("click", () => {
      handleWorkstationSelection(id);
    });

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
    overflowWrap.addEventListener("click", () => {
      handleWorkstationSelection(id);
    });

    const failureMarker = document.createElement("div");
    failureMarker.className = "workstation-failure-marker";
    failureMarker.setAttribute("aria-hidden", "true");

    station.append(node, overflowWrap, failureMarker);
    return {
      element: station,
      button: node,
      badge,
      indicator,
      overflowWrap,
      overflowLabel,
      failureMarker,
    };
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
  // TASK NORMALIZATION
  // =============================================================================

  function normalizeTaskSnapshots(summary) {
    if (!summary?.tasks?.length) {
      return [];
    }

    return summary.tasks.map((task) => normalizeTaskSnapshot(task));
  }

  function normalizeTaskSnapshot(task) {
    const id = task?.id !== undefined && task?.id !== null ? String(task.id) : "";
    const status = task?.status ? String(task.status).toLowerCase() : "";
    const role = task?.role ? String(task.role).toLowerCase() : null;
    const tokensUsed = normalizeMetricValue(task?.tokensUsed);
    const cost = normalizeMetricValue(task?.cost);
    const startedAt = resolveTaskStartedAt(id, task?.startedAt);
    const name = task?.name ? String(task.name) : null;
    const workstationId = deriveWorkstationId(status, role);

    return {
      id,
      status,
      role,
      tokensUsed,
      cost,
      startedAt,
      name,
      workstationId,
    };
  }

  function resolveTaskStartedAt(taskId, startedAt) {
    const parsed = parseTimestamp(startedAt);
    if (parsed !== null) {
      return parsed;
    }

    if (!viewState.firstSeenAtByTaskId.has(taskId)) {
      viewState.firstSeenAtByTaskId.set(taskId, Date.now());
    }

    return viewState.firstSeenAtByTaskId.get(taskId);
  }

  function normalizeMetricValue(value) {
    if (value === null || value === undefined) {
      return 0;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function getNormalizedTaskForId(taskId) {
    const normalizedId = String(taskId);
    const cached = viewState.normalizedTaskById.get(normalizedId);
    if (cached) {
      return cached;
    }

    const rawTask = findTaskById(viewState.latestSummary, normalizedId);
    if (rawTask) {
      return normalizeTaskSnapshot(rawTask);
    }

    return {
      id: normalizedId,
      status: "running",
      role: null,
      tokensUsed: 0,
      cost: 0,
      startedAt: resolveTaskStartedAt(normalizedId, null),
      name: null,
      workstationId: deriveWorkstationId("running", null),
    };
  }

  // =============================================================================
  // SNAPSHOT DIFF + VISIBILITY
  // =============================================================================

  function pruneTerminalGrace(now) {
    for (const [taskId, graceUntil] of viewState.terminalGraceUntilByTaskId.entries()) {
      if (graceUntil > now) {
        const task = viewState.normalizedTaskById.get(taskId);
        if (task && isTaskTerminalStatus(task.status)) {
          continue;
        }
      }

      viewState.terminalGraceUntilByTaskId.delete(taskId);
      viewState.terminalStationByTaskId.delete(taskId);
    }
  }

  function updateTerminalGrace(diff, previousSnapshotById, now) {
    for (const taskId of diff.changed) {
      const changes = diff.changesById.get(taskId);
      if (!changes?.becameTerminal) {
        continue;
      }

      const previousTask = previousSnapshotById.get(taskId);
      const stationId = previousTask?.workstationId ?? null;
      if (!stationId) {
        continue;
      }

      viewState.terminalGraceUntilByTaskId.set(taskId, now + END_GRACE_MS);
      viewState.terminalStationByTaskId.set(taskId, stationId);

      const nextTask = diff.nextById.get(taskId);
      if (nextTask?.status === "failed") {
        activateFailureMarker(stationId);
      }
    }
  }

  function getTerminalGraceTasks(normalizedTasks, now) {
    const terminalTasks = [];
    for (const task of normalizedTasks) {
      if (!isTaskTerminalStatus(task.status)) {
        continue;
      }

      const graceUntil = viewState.terminalGraceUntilByTaskId.get(task.id);
      if (!graceUntil || graceUntil <= now) {
        continue;
      }

      const stationId = viewState.terminalStationByTaskId.get(task.id);
      if (!stationId) {
        continue;
      }

      terminalTasks.push({
        ...task,
        workstationId: stationId,
      });
    }

    return terminalTasks;
  }

  function buildPinnedTaskIds(diff, now) {
    const pinned = new Set(diff.changed);
    for (const taskId of viewState.transitionsByTaskId.keys()) {
      pinned.add(taskId);
    }
    for (const [taskId, graceUntil] of viewState.terminalGraceUntilByTaskId.entries()) {
      if (graceUntil > now) {
        pinned.add(taskId);
      }
    }
    return pinned;
  }

  function areSetsEqual(first, second) {
    if (first === second) {
      return true;
    }
    if (!first || !second || first.size !== second.size) {
      return false;
    }
    for (const value of first) {
      if (!second.has(value)) {
        return false;
      }
    }
    return true;
  }

  function clearTransitionsForRemovedTasks(diff) {
    for (const taskId of diff.removed) {
      stopTransitionForTask(taskId);
    }
  }

  function clearTerminalGrace() {
    viewState.terminalGraceUntilByTaskId.clear();
    viewState.terminalStationByTaskId.clear();
  }

  // =============================================================================
  // WORKSTATION MAPPING
  // =============================================================================

  function mapTaskToWorkstation(task) {
    if (task.workstationId !== undefined) {
      return task.workstationId;
    }

    return deriveWorkstationId(task.status, task.role);
  }

  function mapTasksToWorkstations(tasks) {
    const tasksByStation = new Map();
    for (const task of tasks) {
      const stationId = mapTaskToWorkstation(task);
      if (!stationId) {
        continue;
      }
      const stationTasks = tasksByStation.get(stationId);
      if (stationTasks) {
        stationTasks.push(task);
      } else {
        tasksByStation.set(stationId, [task]);
      }
    }

    return tasksByStation;
  }

  // =============================================================================
  // WORKSTATION STATE
  // =============================================================================

  function syncWorkstationIndicators(tasksByStation, visibleTaskIds) {
    if (!viewState.workstationElementsById) {
      return;
    }

    for (const definition of WORKSTATION_DEFINITIONS) {
      const stationId = definition.id;
      const stationTasks = tasksByStation.get(stationId) ?? [];
      const taskIds = stationTasks.map((task) => task.id);
      viewState.workstationTaskIdsById.set(stationId, taskIds);

      const elements = viewState.workstationElementsById.get(stationId);
      if (!elements) {
        continue;
      }

      const totalMappedCount = stationTasks.length;
      const hasActiveTasks = stationTasks.some((task) => isTaskActiveStatus(task.status));
      const slotByTaskId = viewState.slotAssignmentsByStation.get(stationId);

      let slottedVisibleCount = 0;
      if (slotByTaskId) {
        for (const task of stationTasks) {
          if (!visibleTaskIds.has(task.id)) {
            continue;
          }
          if (slotByTaskId.has(task.id)) {
            slottedVisibleCount += 1;
          }
        }
      }

      const overflowCount = Math.max(0, totalMappedCount - slottedVisibleCount);
      elements.badge.textContent = formatCount(totalMappedCount);
      elements.indicator.hidden = !hasActiveTasks;
      elements.overflowWrap.hidden = overflowCount === 0;
      elements.overflowLabel.textContent = `+${overflowCount}`;
      if (elements.button) {
        elements.button.title = buildWorkstationTitle(definition.label, totalMappedCount);
      }
    }
  }

  function activateFailureMarker(stationId) {
    const elements = viewState.workstationElementsById.get(stationId);
    if (!elements?.failureMarker) {
      return;
    }

    const existingTimeout = viewState.failureMarkerTimeoutsByStation.get(stationId);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    elements.failureMarker.classList.add("is-active");
    const timeoutId = window.setTimeout(() => {
      elements.failureMarker.classList.remove("is-active");
      viewState.failureMarkerTimeoutsByStation.delete(stationId);
    }, END_GRACE_MS);

    viewState.failureMarkerTimeoutsByStation.set(stationId, timeoutId);
  }

  function clearFailureMarkers() {
    for (const timeoutId of viewState.failureMarkerTimeoutsByStation.values()) {
      window.clearTimeout(timeoutId);
    }
    viewState.failureMarkerTimeoutsByStation.clear();

    for (const elements of viewState.workstationElementsById.values()) {
      if (elements.failureMarker) {
        elements.failureMarker.classList.remove("is-active");
      }
    }
  }

  // =============================================================================
  // WORKSTATION INTERACTIONS
  // =============================================================================

  function handleWorkstationSelection(stationId) {
    const normalizedStationId = stationId ? String(stationId) : null;
    if (!normalizedStationId) {
      return;
    }

    setSelectedWorkstation(normalizedStationId);

    const taskIds = resolveWorkstationTaskIds(normalizedStationId);
    dispatchWorkstationSelectionEvent(normalizedStationId, taskIds);

    if (taskIds.length === 0) {
      return;
    }

    const representativeTaskId = resolveRepresentativeTaskId(taskIds);
    if (!representativeTaskId) {
      return;
    }

    actions.setSelectedTask(representativeTaskId);
    updateSelectedMushroom(representativeTaskId);
    openInspectorForTask(representativeTaskId);
  }

  function setSelectedWorkstation(stationId) {
    const normalizedStationId = stationId ? String(stationId) : null;
    viewState.selectedWorkstationId = normalizedStationId;
    syncWorkstationSelection();
  }

  function syncWorkstationSelection() {
    if (!viewState.workstationElementsById) {
      return;
    }

    for (const [stationId, elements] of viewState.workstationElementsById.entries()) {
      const isSelected = stationId === viewState.selectedWorkstationId;
      elements.element.classList.toggle("is-selected", isSelected);
      if (elements.button) {
        elements.button.setAttribute("aria-pressed", String(isSelected));
      }
    }
  }

  function dispatchWorkstationSelectionEvent(workstationId, taskIds) {
    if (!container) {
      return;
    }

    container.dispatchEvent(
      new CustomEvent("garden:selectWorkstation", {
        detail: {
          workstationId,
          taskIds,
        },
        bubbles: true,
      }),
    );
  }

  function resolveWorkstationTaskIds(stationId) {
    const taskIds = viewState.workstationTaskIdsById.get(stationId);
    if (Array.isArray(taskIds)) {
      return [...taskIds];
    }

    if (!Array.isArray(viewState.normalizedTasks)) {
      return [];
    }

    const tasksByStation = mapTasksToWorkstations(viewState.normalizedTasks);
    return (tasksByStation.get(stationId) ?? []).map((task) => task.id);
  }

  function resolveRepresentativeTaskId(taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return null;
    }

    let selectedTaskId = null;
    let selectedActivityAt = -Infinity;

    for (const taskId of taskIds) {
      const normalizedTaskId = String(taskId);
      const task = viewState.normalizedTaskById.get(normalizedTaskId);
      const lastEventAt = viewState.lastEventAtByTaskId.get(normalizedTaskId) ?? null;
      const activityAt = lastEventAt ?? task?.startedAt ?? 0;

      if (
        selectedTaskId === null ||
        activityAt > selectedActivityAt ||
        (activityAt === selectedActivityAt && normalizedTaskId.localeCompare(selectedTaskId) > 0)
      ) {
        selectedTaskId = normalizedTaskId;
        selectedActivityAt = activityAt;
      }
    }

    return selectedTaskId;
  }

  function buildWorkstationTitle(label, mappedCount) {
    const countLabel = mappedCount === 1 ? "1 task" : `${mappedCount} tasks`;
    return `${label} | ${countLabel}`;
  }

  // =============================================================================
  // WORKSTATION SLOTS
  // =============================================================================

  function resetWorkstationSlots() {
    viewState.slotAssignmentsByStation.clear();
    viewState.taskIdByStationSlot.clear();
  }

  function syncWorkstationSlots(tasksByStation, visibleTaskIds) {
    for (const { id: stationId } of WORKSTATION_DEFINITIONS) {
      const stationTasks = tasksByStation.get(stationId) ?? [];
      const slotByTaskId = getStationSlotAssignments(stationId);
      const taskIdBySlot = getStationSlotOccupancy(stationId);
      const reservedSlots = viewState.reservedSlotsByStation.get(stationId) ?? new Map();
      const mappedTaskIds = new Set(stationTasks.map((task) => task.id));

      for (const [taskId, slotIndex] of slotByTaskId.entries()) {
        if (mappedTaskIds.has(taskId)) {
          continue;
        }
        const reservedTaskId = reservedSlots.get(slotIndex);
        if (reservedTaskId === taskId) {
          continue;
        }
        if (reservedTaskId) {
          slotByTaskId.delete(taskId);
          continue;
        }
        slotByTaskId.delete(taskId);
      }

      taskIdBySlot.clear();
      for (const [taskId, slotIndex] of slotByTaskId.entries()) {
        taskIdBySlot.set(slotIndex, taskId);
      }
      for (const [slotIndex, taskId] of reservedSlots.entries()) {
        taskIdBySlot.set(slotIndex, taskId);
      }

      const tasksById = new Map(stationTasks.map((task) => [task.id, task]));
      const unassignedTasks = stationTasks.filter((task) => !slotByTaskId.has(task.id));
      const prioritizedTasks = unassignedTasks.filter((task) => visibleTaskIds.has(task.id));
      const remainingTasks = unassignedTasks.filter((task) => !visibleTaskIds.has(task.id));

      prioritizedTasks.sort(compareSlotAssignmentOrder);
      remainingTasks.sort(compareSlotAssignmentOrder);

      assignTasksToSlots({
        tasks: prioritizedTasks,
        slotByTaskId,
        taskIdBySlot,
        tasksById,
        visibleTaskIds,
        reservedSlots,
        allowEviction: true,
      });

      assignTasksToSlots({
        tasks: remainingTasks,
        slotByTaskId,
        taskIdBySlot,
        tasksById,
        visibleTaskIds,
        reservedSlots,
        allowEviction: false,
      });
    }
  }

  function buildSlottedVisibleTasks(tasksByStation, visibleTaskIds) {
    const slottedTasks = [];
    for (const { id: stationId } of WORKSTATION_DEFINITIONS) {
      const stationTasks = tasksByStation.get(stationId) ?? [];
      const slotByTaskId = viewState.slotAssignmentsByStation.get(stationId);
      if (!slotByTaskId) {
        continue;
      }

      for (const task of stationTasks) {
        if (!visibleTaskIds.has(task.id)) {
          continue;
        }
        const slotIndex = slotByTaskId.get(task.id);
        if (slotIndex === undefined || slotIndex === null) {
          continue;
        }
        const slotPoint = WORKSTATION_SLOT_POSITIONS[stationId]?.[slotIndex];
        if (!slotPoint) {
          continue;
        }
        slottedTasks.push({
          task,
          stationId,
          slotIndex,
          slotPoint,
        });
      }
    }

    return slottedTasks;
  }

  function getStationSlotAssignments(stationId) {
    const existing = viewState.slotAssignmentsByStation.get(stationId);
    if (existing) {
      return existing;
    }

    const slotByTaskId = new Map();
    viewState.slotAssignmentsByStation.set(stationId, slotByTaskId);
    return slotByTaskId;
  }

  function getStationSlotOccupancy(stationId) {
    const existing = viewState.taskIdByStationSlot.get(stationId);
    if (existing) {
      return existing;
    }

    const taskIdBySlot = new Map();
    viewState.taskIdByStationSlot.set(stationId, taskIdBySlot);
    return taskIdBySlot;
  }

  function findFirstAvailableStationSlot(taskIdBySlot) {
    for (let slotIndex = 0; slotIndex < MAX_WORKSTATION_SLOTS; slotIndex += 1) {
      if (!taskIdBySlot.has(slotIndex)) {
        return slotIndex;
      }
    }

    return null;
  }

  function compareSlotAssignmentOrder(first, second) {
    if (first.startedAt !== second.startedAt) {
      return first.startedAt - second.startedAt;
    }

    return String(first.id).localeCompare(String(second.id));
  }

  function assignTasksToSlots({
    tasks,
    slotByTaskId,
    taskIdBySlot,
    tasksById,
    visibleTaskIds,
    reservedSlots,
    allowEviction,
  }) {
    for (const task of tasks) {
      let slotIndex = findFirstAvailableStationSlot(taskIdBySlot);
      if (slotIndex === null && allowEviction) {
        slotIndex = findEvictableSlotIndex(taskIdBySlot, tasksById, visibleTaskIds, reservedSlots);
        if (slotIndex !== null) {
          const evictedTaskId = taskIdBySlot.get(slotIndex);
          if (evictedTaskId) {
            slotByTaskId.delete(evictedTaskId);
            taskIdBySlot.delete(slotIndex);
          }
        }
      }
      if (slotIndex === null) {
        continue;
      }
      slotByTaskId.set(task.id, slotIndex);
      taskIdBySlot.set(slotIndex, task.id);
    }
  }

  function findEvictableSlotIndex(taskIdBySlot, tasksById, visibleTaskIds, reservedSlots) {
    let lowestPriority = null;
    for (const [slotIndex, taskId] of taskIdBySlot.entries()) {
      if (reservedSlots.has(slotIndex)) {
        continue;
      }
      if (visibleTaskIds.has(taskId)) {
        continue;
      }
      const task = tasksById.get(taskId);
      if (!task) {
        continue;
      }
      if (!lowestPriority || compareVisibilityPriority(task, lowestPriority.task) > 0) {
        lowestPriority = { slotIndex, task };
      }
    }

    return lowestPriority ? lowestPriority.slotIndex : null;
  }

  function getReservedStationSlots(stationId) {
    const existing = viewState.reservedSlotsByStation.get(stationId);
    if (existing) {
      return existing;
    }

    const reservedSlots = new Map();
    viewState.reservedSlotsByStation.set(stationId, reservedSlots);
    return reservedSlots;
  }

  function reserveStationSlot(stationId, slotIndex, taskId) {
    if (slotIndex === null || slotIndex === undefined) {
      return;
    }

    const reservedSlots = getReservedStationSlots(stationId);
    reservedSlots.set(slotIndex, taskId);
  }

  function releaseStationSlot(stationId, slotIndex, taskId) {
    if (slotIndex === null || slotIndex === undefined) {
      return;
    }

    const reservedSlots = viewState.reservedSlotsByStation.get(stationId);
    if (!reservedSlots) {
      return;
    }

    if (taskId && reservedSlots.get(slotIndex) !== taskId) {
      return;
    }

    reservedSlots.delete(slotIndex);
    if (reservedSlots.size === 0) {
      viewState.reservedSlotsByStation.delete(stationId);
    }
  }

  function releaseReservedSlotsForTask(taskId) {
    for (const [stationId, reservedSlots] of viewState.reservedSlotsByStation.entries()) {
      for (const [slotIndex, reservedTaskId] of reservedSlots.entries()) {
        if (reservedTaskId !== taskId) {
          continue;
        }
        reservedSlots.delete(slotIndex);
      }
      if (reservedSlots.size === 0) {
        viewState.reservedSlotsByStation.delete(stationId);
      }
    }
  }

  // =============================================================================
  // TRANSITIONS
  // =============================================================================

  function reserveMoveOrigins(diff, previousSnapshotById) {
    const originSlotsByTaskId = new Map();
    for (const taskId of diff.changed) {
      if (viewState.transitionsByTaskId.has(taskId)) {
        continue;
      }

      const changes = diff.changesById.get(taskId);
      if (!changes?.workstationChanged || changes.becameTerminal) {
        continue;
      }
      if (diff.added.has(taskId)) {
        continue;
      }

      const previousTask = previousSnapshotById.get(taskId);
      const nextTask = diff.nextById.get(taskId);
      if (!previousTask || !nextTask) {
        continue;
      }
      if (!previousTask.workstationId || !nextTask.workstationId) {
        continue;
      }

      const slotIndex = findAssignedSlotIndex(previousTask.workstationId, taskId);
      const originReservation = { stationId: previousTask.workstationId, slotIndex };
      originSlotsByTaskId.set(taskId, originReservation);
      if (slotIndex !== null) {
        reserveStationSlot(previousTask.workstationId, slotIndex, taskId);
      }
    }

    return originSlotsByTaskId;
  }

  function buildTransitionsFromDiff(diff, previousSnapshotById, originSlotsByTaskId, now) {
    for (const taskId of diff.changed) {
      if (viewState.transitionsByTaskId.has(taskId)) {
        continue;
      }

      const changes = diff.changesById.get(taskId);
      if (!changes) {
        continue;
      }

      const nextTask = diff.nextById.get(taskId);
      if (!nextTask) {
        continue;
      }

      if (changes.becameTerminal) {
        if (viewState.terminalStationByTaskId.has(taskId)) {
          startPoseTransition(taskId, nextTask.status, now);
        }
        continue;
      }

      if (!changes.workstationChanged || diff.added.has(taskId)) {
        continue;
      }

      const previousTask = previousSnapshotById.get(taskId);
      if (!previousTask) {
        continue;
      }

      if (!previousTask.workstationId || !nextTask.workstationId) {
        releaseMoveOriginReservation(originSlotsByTaskId.get(taskId), taskId);
        continue;
      }

      const originReservation = originSlotsByTaskId.get(taskId) ?? {
        stationId: previousTask.workstationId,
        slotIndex: findAssignedSlotIndex(previousTask.workstationId, taskId),
      };
      const startPoint = resolveStationSlotPoint(
        previousTask.workstationId,
        originReservation?.slotIndex ?? null,
      );
      const destinationSlotIndex = findAssignedSlotIndex(nextTask.workstationId, taskId);
      const endPoint = resolveStationSlotPoint(nextTask.workstationId, destinationSlotIndex);

      if (!startPoint || !endPoint) {
        releaseMoveOriginReservation(originReservation, taskId);
        continue;
      }

      const steps = buildMoveSteps(startPoint, endPoint);
      startMoveTransition(taskId, steps, originReservation, now);
    }

    startTransitionTimer();
  }

  function startMoveTransition(taskId, steps, originReservation, now) {
    const transition = {
      type: "move",
      steps,
      stepIndex: 0,
      nextTickAt: now + TICK_INTERVAL_MS,
      originReservation,
    };
    viewState.transitionsByTaskId.set(taskId, transition);
    applyMoveTransitionStep(taskId, transition);
  }

  function startPoseTransition(taskId, status, now) {
    const poseClass = resolvePoseClassForStatus(status);
    if (!poseClass) {
      return;
    }

    const transition = {
      type: "pose",
      poseClass,
      ticksRemaining: resolveTerminalPoseTicks(taskId),
      nextTickAt: now + TICK_INTERVAL_MS,
    };
    viewState.transitionsByTaskId.set(taskId, transition);
    applyPoseTransition(taskId, transition);
  }

  function resolvePoseClassForStatus(status) {
    if (status === "failed") {
      return "pose-failed";
    }
    if (status === "complete") {
      return "pose-complete";
    }
    return null;
  }

  function resolveTerminalPoseTicks(taskId) {
    if (TERMINAL_POSE_TICKS.min === TERMINAL_POSE_TICKS.max) {
      return TERMINAL_POSE_TICKS.min;
    }

    const roll = stableRandom(taskId, "pose");
    return roll > 0.5 ? TERMINAL_POSE_TICKS.max : TERMINAL_POSE_TICKS.min;
  }

  function startTransitionTimer() {
    if (viewState.transitionTimerId !== null) {
      return;
    }
    if (!viewState.isActive) {
      return;
    }
    if (viewState.transitionsByTaskId.size === 0) {
      return;
    }

    viewState.transitionTimerId = window.setInterval(() => {
      advanceTransitions();
    }, TICK_INTERVAL_MS);
  }

  function stopTransitionTimer() {
    if (viewState.transitionTimerId === null) {
      return;
    }

    window.clearInterval(viewState.transitionTimerId);
    viewState.transitionTimerId = null;
  }

  function advanceTransitions() {
    const now = Date.now();
    for (const [taskId, transition] of [...viewState.transitionsByTaskId.entries()]) {
      if (transition.nextTickAt > now) {
        continue;
      }

      if (transition.type === "move") {
        if (transition.stepIndex < transition.steps.length - 1) {
          transition.stepIndex += 1;
          transition.nextTickAt = now + TICK_INTERVAL_MS;
          applyMoveTransitionStep(taskId, transition);
        } else {
          finalizeMoveTransition(taskId, transition);
        }
        continue;
      }

      if (transition.type === "pose") {
        transition.ticksRemaining -= 1;
        if (transition.ticksRemaining <= 0) {
          clearPoseTransition(taskId);
          viewState.transitionsByTaskId.delete(taskId);
          continue;
        }
        transition.nextTickAt = now + TICK_INTERVAL_MS;
        applyPoseTransition(taskId, transition);
      }
    }

    if (viewState.transitionsByTaskId.size === 0) {
      stopTransitionTimer();
    }
  }

  function applyMoveTransitionStep(taskId, transition) {
    const mushroom = viewState.mushroomByTaskId.get(taskId);
    if (!mushroom) {
      return;
    }

    const step = transition.steps?.[transition.stepIndex];
    if (!step) {
      return;
    }

    applySlotPosition(mushroom, step);
    scheduleMyceliumOverlayUpdate();
  }

  function finalizeMoveTransition(taskId, transition) {
    applyMoveTransitionStep(taskId, transition);
    releaseMoveOriginReservation(transition.originReservation, taskId);
    viewState.transitionsByTaskId.delete(taskId);
  }

  function releaseMoveOriginReservation(originReservation, taskId) {
    if (!originReservation) {
      return;
    }

    const { stationId, slotIndex } = originReservation;
    if (!stationId || slotIndex === null || slotIndex === undefined) {
      return;
    }

    releaseStationSlot(stationId, slotIndex, taskId);

    const slotByTaskId = viewState.slotAssignmentsByStation.get(stationId);
    if (slotByTaskId?.get(taskId) === slotIndex) {
      slotByTaskId.delete(taskId);
    }

    const taskIdBySlot = viewState.taskIdByStationSlot.get(stationId);
    if (taskIdBySlot?.get(slotIndex) === taskId) {
      taskIdBySlot.delete(slotIndex);
    }
  }

  function applyPoseTransition(taskId, transition) {
    const mushroom = viewState.mushroomByTaskId.get(taskId);
    if (!mushroom) {
      return;
    }
    updateMushroomPose(mushroom, transition);
  }

  function clearPoseTransition(taskId) {
    const mushroom = viewState.mushroomByTaskId.get(taskId);
    if (mushroom) {
      updateMushroomPose(mushroom, null);
    }
  }

  function stopTransitionForTask(taskId) {
    const transition = viewState.transitionsByTaskId.get(taskId);
    if (!transition) {
      return;
    }

    if (transition.type === "move") {
      releaseMoveOriginReservation(transition.originReservation, taskId);
    }

    if (transition.type === "pose") {
      clearPoseTransition(taskId);
    }

    viewState.transitionsByTaskId.delete(taskId);
    releaseReservedSlotsForTask(taskId);

    if (viewState.transitionsByTaskId.size === 0) {
      stopTransitionTimer();
    }
  }

  function clearTransitions() {
    stopTransitionTimer();
    for (const [taskId, transition] of viewState.transitionsByTaskId.entries()) {
      if (transition.type === "pose") {
        clearPoseTransition(taskId);
      }
    }
    viewState.transitionsByTaskId.clear();
    viewState.reservedSlotsByStation.clear();
  }

  function findAssignedSlotIndex(stationId, taskId) {
    if (!stationId) {
      return null;
    }

    const slotByTaskId = viewState.slotAssignmentsByStation.get(stationId);
    if (!slotByTaskId) {
      return null;
    }

    const slotIndex = slotByTaskId.get(taskId);
    if (slotIndex === undefined || slotIndex === null) {
      return null;
    }
    return slotIndex;
  }

  function resolveStationSlotPoint(stationId, slotIndex) {
    if (!stationId) {
      return null;
    }

    if (slotIndex !== null && slotIndex !== undefined) {
      const slotPoint = WORKSTATION_SLOT_POSITIONS[stationId]?.[slotIndex];
      if (slotPoint) {
        return slotPoint;
      }
    }

    return resolveStationAnchorPoint(stationId);
  }

  function resolveStationAnchorPoint(stationId) {
    const station = WORKSTATION_DEFINITIONS.find((definition) => definition.id === stationId);
    if (!station) {
      return null;
    }

    return {
      xPct: station.anchor.xPct,
      yPct: station.anchor.yPct,
    };
  }

  function buildMoveSteps(startPoint, endPoint) {
    const start = { xPct: startPoint.xPct, yPct: startPoint.yPct };
    const end = { xPct: endPoint.xPct, yPct: endPoint.yPct };
    const steps = [
      start,
      { xPct: start.xPct, yPct: MOVE_LANE_Y_PCT },
      { xPct: end.xPct, yPct: MOVE_LANE_Y_PCT },
      end,
    ];

    return steps.slice(0, MOVE_STEP_COUNT);
  }

  // =============================================================================
  // MUSHROOMS
  // =============================================================================

  function syncSelectedMushroomVisibility(visibleTaskIds, tasksById) {
    const selectedTaskId = appState.selectedTaskId;
    if (!selectedTaskId) {
      updateSelectedMushroom(null);
      return;
    }

    const normalizedTaskId = String(selectedTaskId);
    if (!tasksById.has(normalizedTaskId) || !visibleTaskIds.has(normalizedTaskId)) {
      updateSelectedMushroom(null);
    }
  }

  function syncMushrooms(slottedVisibleTasks) {
    const mount = viewState.agentsLayer ?? viewState.bed;
    if (!mount) {
      return;
    }

    const visibleTaskIds = new Set(slottedVisibleTasks.map((entry) => entry.task.id));

    for (const [taskId, mushroom] of viewState.mushroomByTaskId.entries()) {
      if (!visibleTaskIds.has(taskId)) {
        startDespawn(taskId, mushroom);
      }
    }

    for (const entry of slottedVisibleTasks) {
      const { task, slotPoint } = entry;
      const taskId = task.id;
      const mushroom = viewState.mushroomByTaskId.get(taskId);
      const transition = viewState.transitionsByTaskId.get(taskId);
      const resolvedSlotPoint = resolveTransitionSlotPoint(transition, slotPoint);

      if (mushroom) {
        cancelDespawn(taskId, mushroom);
        applySlotPosition(mushroom, resolvedSlotPoint);
        updateMushroomSelection(mushroom, taskId);
        updateMushroomStatus(mushroom, task);
        updateMushroomActivity(mushroom, task);
        updateMushroomPose(mushroom, transition);
        continue;
      }

      const newMushroom = createMushroom(task, resolvedSlotPoint);
      viewState.mushroomByTaskId.set(taskId, newMushroom);
      mount.appendChild(newMushroom);
      updateMushroomActivity(newMushroom, task);
      updateMushroomPose(newMushroom, transition);
      triggerSpawn(taskId, newMushroom);
    }
  }

  function createMushroom(task, slotPoint) {
    const taskId = task.id;
    const mushroom = document.createElement("button");
    mushroom.type = "button";
    mushroom.className = "mushroom";
    mushroom.dataset.taskId = taskId;
    mushroom.setAttribute("aria-label", `Select task ${task.name || taskId}`);

    applySlotPosition(mushroom, slotPoint);
    updateMushroomSelection(mushroom, taskId);
    updateMushroomStatus(mushroom, task);

    mushroom.addEventListener("click", () => {
      actions.setSelectedTask(taskId);
      updateSelectedMushroom(taskId);
      openInspectorForTask(taskId);
    });

    const float = document.createElement("div");
    float.className = "mushroom-float";

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
    label.textContent = task.name || taskId;

    float.append(body, label);
    mushroom.appendChild(float);

    return mushroom;
  }

  function applySlotPosition(mushroom, slotPoint) {
    if (!slotPoint) {
      return;
    }

    mushroom.style.setProperty("--slot-x", `${slotPoint.xPct}%`);
    mushroom.style.setProperty("--slot-y", `${slotPoint.yPct}%`);
  }

  function resolveTransitionSlotPoint(transition, slotPoint) {
    if (transition?.type !== "move") {
      return slotPoint;
    }

    return transition.steps?.[transition.stepIndex] ?? slotPoint;
  }

  function updateMushroomPose(mushroom, transition) {
    const poseClass = resolvePoseClass(transition);
    mushroom.classList.toggle("pose-failed", poseClass === "pose-failed");
    mushroom.classList.toggle("pose-complete", poseClass === "pose-complete");
  }

  function resolvePoseClass(transition) {
    if (!transition || transition.type !== "pose" || transition.ticksRemaining <= 0) {
      return null;
    }

    return transition.poseClass;
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
    if (!viewState.bed && !viewState.agentsLayer) {
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

  function updateMushroomStatus(mushroom, task) {
    const status = task.status || "";
    mushroom.dataset.status = status;
    mushroom.classList.toggle("is-running", status === "running");
    mushroom.classList.toggle("is-needs-review", status === "needs_review");
    mushroom.classList.toggle("is-needs-rescope", status === "needs_rescope");
  }

  function updateMushroomActivity(mushroom, task) {
    const ribbon = mushroom.querySelector(".mushroom-ribbon");
    if (!ribbon) {
      return;
    }

    const activityLabel = resolveMushroomRibbonLabel(task);
    ribbon.textContent = activityLabel;
    mushroom.title = buildMushroomTitle(task);
  }

  function resolveMushroomRibbonLabel(task) {
    if (task.status === "needs_review") {
      return "REVIEW";
    }
    if (task.status === "needs_rescope") {
      return "RESCOPE";
    }

    const eventType = viewState.lastEventTypeByTaskId.get(task.id);
    return classifyActivityLabel(eventType);
  }

  function buildMushroomTitle(task) {
    const name = task.name || task.id;
    const statusLabel = formatTaskStatus(task.status);
    const tokensUsed = formatMetric(task.tokensUsed);
    const cost = formatMetric(task.cost);
    return `${name} | ${statusLabel} | tokens ${tokensUsed} | cost ${cost}`;
  }

  function formatTaskStatus(status) {
    if (!status) {
      return "unknown";
    }

    return String(status).replace(/_/g, " ");
  }

  function formatMetric(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "--";
    }

    return String(value);
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

    const runningTasks = getRunningTasks(viewState.normalizedTasks);
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

    const task = getNormalizedTaskForId(taskId);
    if (task) {
      updateMushroomActivity(mushroom, task);
    }
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

    const runningTasks = getRunningTasks(viewState.normalizedTasks);
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

  function getRunningTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return [];
    }

    return tasks
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
