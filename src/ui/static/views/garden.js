// Garden view renderer for the Mycelium UI.
// Purpose: render running tasks as mushrooms and status counts as landmarks.
// Usage: created by app.js and driven via onSummary callbacks.

export function createGardenView({ appState, actions }) {
  const container = document.getElementById("view-garden");

  const viewState = {
    isActive: true,
    latestSummary: null,
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

    const runningTasks = getRunningTasks(summary);
    const taskCounts = summary?.taskCounts ?? {};
    const emptyTitle = options.emptyTitle ?? "No running tasks yet.";
    const emptyCopy = options.emptyCopy ?? "Mushrooms appear as tasks move into running.";

    container.innerHTML = "";

    const garden = document.createElement("div");
    garden.className = "garden";

    const landmarks = renderLandmarks(taskCounts);
    const bed = document.createElement("div");
    bed.className = "garden-bed";

    if (!runningTasks.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "garden-empty";

      const emptyTitleEl = document.createElement("div");
      emptyTitleEl.className = "garden-empty-title";
      emptyTitleEl.textContent = emptyTitle;

      const emptyCopyEl = document.createElement("div");
      emptyCopyEl.className = "garden-empty-copy";
      emptyCopyEl.textContent = emptyCopy;

      emptyState.append(emptyTitleEl, emptyCopyEl);
      bed.appendChild(emptyState);
    } else {
      const fragment = document.createDocumentFragment();
      runningTasks.forEach((task, index) => {
        fragment.appendChild(createMushroom(task, index));
      });
      bed.appendChild(fragment);
    }

    garden.append(landmarks, bed);
    container.appendChild(garden);
  }

  function renderLandmarks(taskCounts) {
    const landmarks = document.createElement("div");
    landmarks.className = "garden-landmarks";

    const landmarkDefinitions = [
      {
        key: "spore",
        label: "Spore Basket",
        detail: "Pending",
        count: taskCounts.pending,
      },
      {
        key: "compost",
        label: "Compost Pile",
        detail: "Failed",
        count: taskCounts.failed,
      },
      {
        key: "harvest",
        label: "Harvest Shelf",
        detail: "Complete",
        count: taskCounts.complete,
      },
    ];

    for (const definition of landmarkDefinitions) {
      landmarks.appendChild(createLandmark(definition));
    }

    return landmarks;
  }

  function createLandmark({ key, label, detail, count }) {
    const wrapper = document.createElement("div");
    wrapper.className = `garden-landmark landmark-${key}`;

    const header = document.createElement("div");
    header.className = "landmark-header";

    const icon = document.createElement("div");
    icon.className = "landmark-icon";

    const countEl = document.createElement("div");
    countEl.className = "landmark-count";
    countEl.textContent = formatCount(count);

    header.append(icon, countEl);

    const labelEl = document.createElement("div");
    labelEl.className = "landmark-label";
    labelEl.textContent = label;

    const detailEl = document.createElement("div");
    detailEl.className = "landmark-detail";
    detailEl.textContent = detail;

    wrapper.append(header, labelEl, detailEl);
    return wrapper;
  }

  function createMushroom(task, index) {
    const taskId = String(task.id);
    const mushroom = document.createElement("button");
    mushroom.type = "button";
    mushroom.className = "mushroom is-running";
    mushroom.dataset.taskId = taskId;
    mushroom.style.setProperty("--bob-delay", `${(index % 6) * 0.12}s`);
    mushroom.title = `Task ${taskId} is running`;
    mushroom.setAttribute("aria-label", `Select task ${taskId}`);
    if (taskId === appState.selectedTaskId) {
      mushroom.classList.add("is-selected");
    }

    mushroom.addEventListener("click", () => {
      actions.setSelectedTask(taskId);
      updateSelectedMushroom(taskId);
    });

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

    mushroom.append(body, label, status);

    return mushroom;
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
