// Garden view renderer for the Mycelium UI.
// Purpose: render running tasks as mushrooms and status counts as landmarks.
// Usage: created by app.js and driven via onSummary callbacks.

export function createGardenView({ appState, actions }) {
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
  const slotColumnPositions = buildSlotColumnPositions();

  const viewState = {
    isActive: true,
    latestSummary: null,
    gardenSlots: buildInitialSlots(INITIAL_SLOT_COUNT),
    slotByTaskId: new Map(),
    taskIdBySlot: new Map(),
    garden: null,
    landmarks: null,
    bed: null,
    emptyState: null,
    emptyTitleEl: null,
    emptyCopyEl: null,
    landmarkCountEls: new Map(),
    mushroomByTaskId: new Map(),
    spawnTimeouts: new Map(),
    despawnTimeouts: new Map(),
  };

  return {
    init,
    reset,
    onSummary,
    setActive,
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
    resetSlotAllocator();
    clearPendingMushroomTimers();
    clearMushrooms();
    renderEmptyState();
  }

  function setActive(isActive) {
    viewState.isActive = isActive;
    if (!isActive) {
      return;
    }

    if (viewState.latestSummary) {
      renderGarden(viewState.latestSummary);
      return;
    }

    renderEmptyState();
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
  }


  // =============================================================================
  // DOM FRAME
  // =============================================================================

  function ensureGardenFrame() {
    if (!container || viewState.garden) {
      return;
    }

    container.innerHTML = "";

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
    container.appendChild(garden);

    viewState.garden = garden;
    viewState.landmarks = landmarks;
    viewState.bed = bed;
    viewState.emptyState = emptyState;
    viewState.emptyTitleEl = emptyTitleEl;
    viewState.emptyCopyEl = emptyCopyEl;
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
        continue;
      }

      const newMushroom = createMushroom(task, slotIndex);
      viewState.mushroomByTaskId.set(taskId, newMushroom);
      viewState.bed.appendChild(newMushroom);
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
    });

    const float = document.createElement("div");
    float.className = "mushroom-float bob";

    const body = document.createElement("div");
    body.className = "mushroom-body";

    const cap = document.createElement("div");
    cap.className = "mushroom-cap";

    const stem = document.createElement("div");
    stem.className = "mushroom-stem";

    body.append(cap, stem);

    const label = document.createElement("div");
    label.className = "mushroom-label";
    label.textContent = taskId;

    const status = document.createElement("div");
    status.className = "mushroom-status";
    status.textContent = "WORKING...";

    float.append(body, label, status);
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

    viewState.spawnTimeouts.clear();
    viewState.despawnTimeouts.clear();
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
}
