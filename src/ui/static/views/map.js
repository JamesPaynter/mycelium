// Map view renderer for the Mycelium UI.
// Purpose: render a deterministic dependency map as a mycelium network.
// Usage: created by app.js and driven via setActive/reset/refresh.

const SVG_NS = "http://www.w3.org/2000/svg";

const MAP_LAYOUT = {
  stagePadding: 64,
  edgeCurveScale: 0.25,
  edgeCurveMin: 22,
  edgeCurveMax: 120,
  hyphaStrokeMin: 1,
  hyphaStrokeMax: 6,
  hyphaStrokeBase: 1,
  knotGlowRadius: 10,
  knotCoreRadius: 4,
  knotCoreMinRadius: 3,
  knotCoreMaxRadius: 9,
  knotGlowMinRadius: 7,
  knotGlowMaxRadius: 16,
  mushroomOffsetX: 14,
  mushroomOffsetY: -12,
  fairyOrbitOffsetX: -16,
  fairyOrbitOffsetY: -12,
  fairyOrbitRadius: 9,
  fairyCount: 3,
  labelOffset: 18,
};

export function createMapView({ appState } = {}) {
  const container = document.getElementById("view-map");

  const viewState = {
    isActive: true,
    isLoading: false,
    requestId: 0,
    snapshot: null,
    resizeObserver: null,
    resizeFrameId: null,
    selectedComponentId: null,
    shouldDimNonNeighbors: true,
    graphData: null,
    nodeElementsById: new Map(),
    edgeElements: [],
  };

  const elements = {
    shell: null,
    headerSubtext: null,
    meta: {
      components: null,
      edges: null,
      baseSha: null,
    },
    stage: null,
    svg: null,
    legend: null,
    legendFairyOrbit: null,
    legendFairyStatus: null,
    message: null,
    messageTitle: null,
    messageCopy: null,
    messageDetail: null,
    inspector: {
      panel: null,
      subtext: null,
      closeButton: null,
      dimToggle: null,
      componentId: null,
      rootsList: null,
      depsList: null,
      reverseDepsList: null,
      stats: {
        codeLoc: null,
        codeFiles: null,
        unitTestFiles: null,
        integrationTestFiles: null,
        e2eTestFiles: null,
      },
      commands: {
        showComponent: null,
        showDependencies: null,
        showReverseDependencies: null,
      },
    },
  };

  return {
    init,
    reset,
    setActive,
    refresh,
  };

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    if (!container) {
      return;
    }

    container.classList.remove("view-placeholder");
    container.classList.add("map-view");

    buildShell();
    wireInspectorControls();
    attachResizeObserver();
    renderEmptyState();
  }

  function buildShell() {
    container.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = "map-shell";

    const header = document.createElement("div");
    header.className = "panel-header map-header";

    const titleWrap = document.createElement("div");

    const title = document.createElement("h2");
    title.textContent = "Map";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    titleWrap.append(title, subtext);

    const meta = document.createElement("div");
    meta.className = "map-meta";

    const componentsMeta = buildMetaItem("Components");
    const edgesMeta = buildMetaItem("Edges");
    const baseShaMeta = buildMetaItem("Base SHA");

    meta.append(componentsMeta.wrap, edgesMeta.wrap, baseShaMeta.wrap);

    header.append(titleWrap, meta);

    const body = document.createElement("div");
    body.className = "map-body";

    const stage = document.createElement("div");
    stage.className = "map-stage";

    const svg = createSvgElement("svg", "map-graph");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Codebase dependency map");

    const legend = buildLegend();

    const message = document.createElement("div");
    message.className = "map-message";

    const messageCard = document.createElement("div");
    messageCard.className = "map-message-card";

    const messageTitle = document.createElement("div");
    messageTitle.className = "map-message-title";

    const messageCopy = document.createElement("div");
    messageCopy.className = "map-message-copy";

    const messageDetail = document.createElement("div");
    messageDetail.className = "map-message-detail";

    messageCard.append(messageTitle, messageCopy, messageDetail);
    message.append(messageCard);
    stage.append(svg, legend.wrap, message);

    const inspector = buildInspectorPanel();

    body.append(stage, inspector.panel);
    shell.append(header, body);
    container.append(shell);

    elements.shell = shell;
    elements.headerSubtext = subtext;
    elements.meta.components = componentsMeta.value;
    elements.meta.edges = edgesMeta.value;
    elements.meta.baseSha = baseShaMeta.value;
    elements.stage = stage;
    elements.svg = svg;
    elements.legend = legend.wrap;
    elements.legendFairyOrbit = legend.fairyOrbit;
    elements.legendFairyStatus = legend.fairyStatus;
    elements.message = message;
    elements.messageTitle = messageTitle;
    elements.messageCopy = messageCopy;
    elements.messageDetail = messageDetail;
    elements.inspector.panel = inspector.panel;
    elements.inspector.subtext = inspector.subtext;
    elements.inspector.closeButton = inspector.closeButton;
    elements.inspector.dimToggle = inspector.dimToggle;
    elements.inspector.componentId = inspector.componentId;
    elements.inspector.rootsList = inspector.rootsList;
    elements.inspector.depsList = inspector.depsList;
    elements.inspector.reverseDepsList = inspector.reverseDepsList;
    elements.inspector.stats = inspector.stats;
    elements.inspector.commands = inspector.commands;
  }

  function buildMetaItem(label) {
    const wrap = document.createElement("div");
    wrap.className = "map-meta-item";

    const labelEl = document.createElement("span");
    labelEl.className = "map-meta-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "map-meta-value";
    valueEl.textContent = "—";

    wrap.append(labelEl, valueEl);
    return { wrap, value: valueEl };
  }

  function buildLegend() {
    const wrap = document.createElement("div");
    wrap.className = "map-legend";
    wrap.hidden = true;

    const title = document.createElement("div");
    title.className = "map-legend-title";
    title.textContent = "Growth semantics";

    const list = document.createElement("div");
    list.className = "map-legend-list";

    const hypha = buildLegendItem({
      label: "Hypha thickness = code footprint",
      tooltip: "Thickness uses log10(1 + code_loc), clamped.",
      icon: buildLegendHyphaIcon(),
    });

    const mushroom = buildLegendItem({
      label: "Mushroom = unit tests",
      tooltip: "Shown when unit_test_files > 0.",
      icon: buildLegendMushroomIcon(),
    });

    const fairy = buildLegendFairyItem();

    list.append(hypha.wrap, mushroom.wrap, fairy.wrap);
    wrap.append(title, list);

    return {
      wrap,
      fairyOrbit: fairy.orbit,
      fairyStatus: fairy.status,
    };
  }

  function buildLegendItem({ label, tooltip, icon }) {
    const wrap = document.createElement("div");
    wrap.className = "map-legend-item";
    if (tooltip) {
      wrap.title = tooltip;
    }

    const labelEl = document.createElement("div");
    labelEl.className = "map-legend-label";
    labelEl.textContent = label;

    wrap.append(icon, labelEl);

    return { wrap, label: labelEl };
  }

  function buildLegendHyphaIcon() {
    const svg = createLegendSvg("0 0 32 20");
    const thin = createSvgElement("line", "map-legend-hypha");
    thin.setAttribute("x1", "4");
    thin.setAttribute("x2", "28");
    thin.setAttribute("y1", "6");
    thin.setAttribute("y2", "6");
    thin.setAttribute("stroke-width", "1.2");

    const thick = createSvgElement("line", "map-legend-hypha");
    thick.setAttribute("x1", "4");
    thick.setAttribute("x2", "28");
    thick.setAttribute("y1", "14");
    thick.setAttribute("y2", "14");
    thick.setAttribute("stroke-width", "4.8");

    svg.append(thin, thick);
    return svg;
  }

  function buildLegendMushroomIcon() {
    const svg = createLegendSvg("-10 -12 20 20");
    svg.append(createMushroomGroup());
    return svg;
  }

  function buildLegendFairyItem() {
    const svg = createLegendSvg("-10 -10 20 20");
    const orbit = createFairyOrbit({
      radius: 5,
      count: 3,
      shouldAnimate: false,
      isSleeping: true,
    });
    svg.append(orbit);

    const labelWrap = document.createElement("div");
    labelWrap.className = "map-legend-label";

    const label = document.createElement("div");
    label.textContent = "Fairies = integration/e2e tests";

    const status = document.createElement("div");
    status.className = "map-legend-status";
    status.textContent = "Integration doctor: unknown";

    labelWrap.append(label, status);

    const wrap = document.createElement("div");
    wrap.className = "map-legend-item";
    wrap.title = "Shown when integration_test_files + e2e_test_files > 0.";
    wrap.append(svg, labelWrap);

    return { wrap, orbit, status };
  }

  function createLegendSvg(viewBox) {
    const svg = createSvgElement("svg", "map-legend-icon");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function buildInspectorPanel() {
    const panel = document.createElement("aside");
    panel.className = "map-inspector panel";
    panel.hidden = true;

    const header = document.createElement("div");
    header.className = "panel-header";

    const titleWrap = document.createElement("div");

    const title = document.createElement("h2");
    title.textContent = "Component";

    const subtext = document.createElement("div");
    subtext.className = "subtext";
    subtext.textContent = "Select a node to inspect.";

    titleWrap.append(title, subtext);

    const meta = document.createElement("div");
    meta.className = "panel-meta";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "drawer-close";
    closeButton.setAttribute("aria-label", "Close inspector");
    closeButton.textContent = "✕";
    meta.append(closeButton);

    header.append(titleWrap, meta);

    const body = document.createElement("div");
    body.className = "detail-body";

    const controls = document.createElement("div");
    controls.className = "map-inspector-controls";

    const dimToggleLabel = document.createElement("label");
    dimToggleLabel.className = "toggle";

    const dimToggle = document.createElement("input");
    dimToggle.type = "checkbox";
    dimToggle.checked = viewState.shouldDimNonNeighbors;

    const dimToggleText = document.createElement("span");
    dimToggleText.textContent = "Dim non-neighbors";

    dimToggleLabel.append(dimToggle, dimToggleText);
    controls.append(dimToggleLabel);

    const componentSection = createInspectorSection("Component");
    const componentIdRow = createInspectorRow("Component ID");
    componentSection.body.append(componentIdRow.row);

    const rootsSection = createInspectorSection("Roots");
    const rootsList = document.createElement("div");
    rootsList.className = "map-inspector-list";
    rootsSection.body.append(rootsList);

    const dependenciesSection = createInspectorSection("Dependencies");
    const dependenciesList = document.createElement("div");
    dependenciesList.className = "map-inspector-list";
    dependenciesSection.body.append(dependenciesList);

    const reverseDependenciesSection = createInspectorSection("Reverse dependencies");
    const reverseDependenciesList = document.createElement("div");
    reverseDependenciesList.className = "map-inspector-list";
    reverseDependenciesSection.body.append(reverseDependenciesList);

    const statsSection = createInspectorSection("Stats");
    const statsGrid = document.createElement("div");
    statsGrid.className = "detail-meta";

    const codeLocEntry = createStatsEntry("Code LOC");
    const codeFilesEntry = createStatsEntry("Code files");
    const unitTestsEntry = createStatsEntry("Unit test files");
    const integrationTestsEntry = createStatsEntry("Integration test files");
    const e2eTestsEntry = createStatsEntry("E2E test files");

    statsGrid.append(
      codeLocEntry.wrapper,
      codeFilesEntry.wrapper,
      unitTestsEntry.wrapper,
      integrationTestsEntry.wrapper,
      e2eTestsEntry.wrapper,
    );
    statsSection.body.append(statsGrid);

    const commandsSection = createInspectorSection("Control Plane commands");
    const showCommand = buildCommandRow("Show component");
    const dependenciesCommand = buildCommandRow("Show deps");
    const reverseDependenciesCommand = buildCommandRow("Show reverse deps");

    commandsSection.body.append(
      showCommand.row,
      dependenciesCommand.row,
      reverseDependenciesCommand.row,
    );

    body.append(
      controls,
      componentSection.section,
      rootsSection.section,
      dependenciesSection.section,
      reverseDependenciesSection.section,
      statsSection.section,
      commandsSection.section,
    );

    panel.append(header, body);

    return {
      panel,
      subtext,
      closeButton,
      dimToggle,
      componentId: componentIdRow.value,
      rootsList,
      depsList: dependenciesList,
      reverseDepsList: reverseDependenciesList,
      stats: {
        codeLoc: codeLocEntry.value,
        codeFiles: codeFilesEntry.value,
        unitTestFiles: unitTestsEntry.value,
        integrationTestFiles: integrationTestsEntry.value,
        e2eTestFiles: e2eTestsEntry.value,
      },
      commands: {
        showComponent: showCommand,
        showDependencies: dependenciesCommand,
        showReverseDependencies: reverseDependenciesCommand,
      },
    };
  }

  function createInspectorSection(title) {
    const section = document.createElement("div");
    section.className = "map-inspector-section";

    const heading = document.createElement("h3");
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "map-inspector-section-body";

    section.append(heading, body);
    return { section, body };
  }

  function createInspectorRow(labelText) {
    const row = document.createElement("div");
    row.className = "map-inspector-row";

    const label = document.createElement("div");
    label.className = "map-inspector-label";
    label.textContent = labelText;

    const value = document.createElement("div");
    value.className = "map-inspector-value";
    value.textContent = "—";

    row.append(label, value);
    return { row, value };
  }

  function createStatsEntry(labelText) {
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

  function buildCommandRow(labelText) {
    const row = document.createElement("div");
    row.className = "map-command-row";

    const label = document.createElement("div");
    label.className = "map-command-label";
    label.textContent = labelText;

    const controls = document.createElement("div");
    controls.className = "map-command-controls";

    const input = document.createElement("input");
    input.className = "map-command-input";
    input.type = "text";
    input.readOnly = true;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn tiny ghost";
    button.textContent = "Copy";

    controls.append(input, button);
    row.append(label, controls);

    return { row, input, button };
  }

  function attachResizeObserver() {
    if (!elements.stage || typeof ResizeObserver === "undefined") {
      return;
    }

    viewState.resizeObserver = new ResizeObserver(() => {
      if (!viewState.isActive || !viewState.snapshot) {
        return;
      }
      scheduleResizeRender();
    });

    viewState.resizeObserver.observe(elements.stage);
  }

  function wireInspectorControls() {
    if (elements.inspector.closeButton) {
      elements.inspector.closeButton.addEventListener("click", () => {
        clearSelection();
      });
    }

    if (elements.inspector.dimToggle) {
      elements.inspector.dimToggle.addEventListener("change", () => {
        viewState.shouldDimNonNeighbors = elements.inspector.dimToggle.checked;
        applyGraphHighlighting();
      });
    }

    if (elements.svg) {
      elements.svg.addEventListener("click", (event) => {
        const clickedNode = event.target?.closest?.(".map-node");
        if (clickedNode) {
          return;
        }
        clearSelection();
      });
    }

    for (const command of Object.values(elements.inspector.commands)) {
      if (!command?.button) {
        continue;
      }
      command.button.addEventListener("click", () => {
        void copyCommandToClipboard(command.input.value, command.input);
      });
    }
  }

  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    viewState.snapshot = null;
    viewState.isLoading = false;
    viewState.requestId += 1;
    viewState.graphData = null;
    viewState.nodeElementsById.clear();
    viewState.edgeElements = [];
    clearSelection();
    renderEmptyState();
  }

  function setActive(isActive) {
    viewState.isActive = isActive;
    if (isActive) {
      updateSubtext();
      void refresh();
    }
  }

  async function refresh() {
    if (!viewState.isActive) {
      return;
    }

    if (!hasTarget()) {
      renderEmptyState();
      return;
    }

    const requestId = ++viewState.requestId;
    viewState.isLoading = true;
    renderLoadingState();

    const url = buildCodeGraphUrl();
    const response = await fetchCodeGraphSnapshot(url);

    if (requestId !== viewState.requestId) {
      return;
    }

    viewState.isLoading = false;

    if (!response.ok) {
      viewState.snapshot = null;
      renderErrorState(response.error);
      return;
    }

    viewState.snapshot = response.result;
    renderGraph(response.result);
  }

  // =============================================================================
  // API
  // =============================================================================

  async function fetchCodeGraphSnapshot(url) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "INVALID_JSON",
            message: `Invalid JSON response from ${url}.`,
          },
        };
      }

      if (!response.ok || !payload?.ok) {
        const error = payload?.error ?? {
          code: "REQUEST_FAILED",
          message: response.statusText || "Request failed.",
        };
        return { ok: false, error };
      }

      return { ok: true, result: payload.result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: toErrorMessage(error),
        },
      };
    }
  }

  function buildCodeGraphUrl() {
    return `/api/projects/${encodeURIComponent(appState.projectName)}/runs/${encodeURIComponent(
      appState.runId,
    )}/code-graph`;
  }

  // =============================================================================
  // RENDERING
  // =============================================================================

  function renderEmptyState() {
    updateSubtext();
    updateMeta(null);
    viewState.graphData = null;
    clearSvg();
    clearSelection();
    setLegendVisibility(false);
    showMessage({
      title: "Map view",
      copy: "Choose a project and run to load the dependency map.",
      detail: "",
    });
  }

  function renderLoadingState() {
    updateSubtext();
    setLegendVisibility(false);
    showMessage({
      title: "Loading map",
      copy: "Fetching the control-plane graph snapshot.",
      detail: "",
    });
  }

  function renderErrorState(error) {
    updateSubtext();
    const baseSha = extractBaseSha(error);
    updateMeta(null);
    setLegendVisibility(false);
    if (baseSha) {
      setMetaValue(elements.meta.baseSha, baseSha);
    }
    viewState.graphData = null;
    clearSvg();
    clearSelection();

    if (error?.code === "MODEL_NOT_FOUND") {
      renderModelMissingPrompt(baseSha);
      return;
    }

    const hint = error?.hint ?? "";
    showMessage({
      title: "Unable to load map",
      copy: error?.message ?? "Request failed.",
      detail: hint,
    });
  }

  function renderModelMissingPrompt(baseSha) {
    const command = baseSha ? `mycelium cp build --base-sha ${baseSha}` : "mycelium cp build";
    showMessage({
      title: "No control-plane model found.",
      copy: "Run the control-plane build to render this map.",
      detail: command,
      detailIsCommand: true,
    });
  }

  function renderGraph(snapshot) {
    updateSubtext();
    updateMeta(snapshot);

    const stageSize = getStageSize();
    if (!stageSize) {
      return;
    }

    const components = Array.isArray(snapshot.components) ? snapshot.components : [];
    const deps = Array.isArray(snapshot.deps) ? snapshot.deps : [];
    const statsById = normalizeStatsById(snapshot.stats);
    const integrationDoctorPassed = snapshot.run_quality?.integration_doctor_passed ?? null;

    if (!components.length) {
      viewState.graphData = null;
      clearSvg();
      clearSelection();
      setLegendVisibility(false);
      showMessage({
        title: "No components found",
        copy: "The control-plane model has no components to visualize.",
        detail: "",
      });
      return;
    }

    const componentsById = buildComponentsById(components);
    const dependencyMaps = buildDependencyMaps(componentsById, deps);
    viewState.graphData = {
      componentsById,
      depsOut: dependencyMaps.depsOut,
      depsIn: dependencyMaps.depsIn,
      statsById,
    };

    hideMessage();
    clearSvg();
    setLegendVisibility(true);
    updateLegend({ integrationDoctorPassed });
    renderGraphSvg({
      components,
      deps,
      stageSize,
      statsById,
      shouldAnimateFairies: integrationDoctorPassed === true,
    });
    syncSelectionWithGraph();
  }

  function renderGraphSvg({ components, deps, stageSize, statsById, shouldAnimateFairies }) {
    const width = stageSize.width;
    const height = stageSize.height;

    elements.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.svg.setAttribute("width", String(width));
    elements.svg.setAttribute("height", String(height));

    viewState.nodeElementsById.clear();
    viewState.edgeElements = [];

    const graphData = buildGraphLayout({
      components,
      deps,
      stageSize,
      statsById,
      shouldAnimateFairies,
    });

    const edgesGroup = createSvgElement("g", "map-edges");
    for (const edge of graphData.edges) {
      const path = createSvgElement("path", "map-hypha");
      path.setAttribute("d", edge.path);
      path.setAttribute("stroke-width", edge.strokeWidth.toFixed(2));
      path.dataset.edgeFrom = edge.from;
      path.dataset.edgeTo = edge.to;
      viewState.edgeElements.push({ element: path, from: edge.from, to: edge.to });
      edgesGroup.append(path);
    }

    const nodesGroup = createSvgElement("g", "map-nodes");
    for (const node of graphData.nodes) {
      const nodeGroup = createSvgElement("g", "map-node");
      nodeGroup.setAttribute("transform", `translate(${node.x}, ${node.y})`);
      nodeGroup.setAttribute("data-node-id", node.id);
      nodeGroup.setAttribute("role", "button");
      nodeGroup.setAttribute("tabindex", "0");
      nodeGroup.setAttribute("aria-label", `Inspect component ${node.id}`);
      nodeGroup.addEventListener("click", (event) => {
        event.stopPropagation();
        setSelectedComponentId(node.id);
      });
      nodeGroup.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setSelectedComponentId(node.id);
        }
      });
      viewState.nodeElementsById.set(node.id, nodeGroup);

      const tooltip = createSvgElement("title");
      tooltip.textContent = node.tooltip;

      const glow = createSvgElement("circle", "map-knot-glow");
      glow.setAttribute("r", String(node.glowRadius));

      const core = createSvgElement("circle", "map-knot-core");
      core.setAttribute("r", String(node.coreRadius));

      const nodeElements = [tooltip, glow, core];

      if (node.hasMushroom) {
        const mushroom = createMushroomGroup({
          offsetX: MAP_LAYOUT.mushroomOffsetX,
          offsetY: MAP_LAYOUT.mushroomOffsetY,
        });
        nodeElements.push(mushroom);
      }

      if (node.hasFairies) {
        const fairies = createFairyOrbit({
          offsetX: MAP_LAYOUT.fairyOrbitOffsetX,
          offsetY: MAP_LAYOUT.fairyOrbitOffsetY,
          radius: MAP_LAYOUT.fairyOrbitRadius,
          count: MAP_LAYOUT.fairyCount,
          shouldAnimate: node.shouldAnimateFairies,
          isSleeping: !node.shouldAnimateFairies,
        });
        nodeElements.push(fairies);
      }

      const label = createSvgElement("text", "map-label");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("y", String(MAP_LAYOUT.labelOffset));
      label.textContent = node.label;

      nodeElements.push(label);
      nodeGroup.append(...nodeElements);
      nodesGroup.append(nodeGroup);
    }

    elements.svg.append(edgesGroup, nodesGroup);
  }

  function createMushroomGroup({ offsetX = 0, offsetY = 0 } = {}) {
    const group = createSvgElement("g", "map-mushroom-icon");
    if (offsetX || offsetY) {
      group.setAttribute("transform", `translate(${offsetX}, ${offsetY})`);
    }

    const cap = createSvgElement("circle", "map-mushroom-cap");
    cap.setAttribute("r", "6");
    cap.setAttribute("cy", "-3");

    const stem = createSvgElement("rect", "map-mushroom-stem");
    stem.setAttribute("x", "-2.2");
    stem.setAttribute("y", "0");
    stem.setAttribute("width", "4.4");
    stem.setAttribute("height", "6.8");
    stem.setAttribute("rx", "1.6");

    group.append(cap, stem);
    return group;
  }

  function createFairyOrbit({
    offsetX = 0,
    offsetY = 0,
    radius = MAP_LAYOUT.fairyOrbitRadius,
    count = MAP_LAYOUT.fairyCount,
    shouldAnimate = false,
    isSleeping = false,
  } = {}) {
    const orbit = createSvgElement("g", "map-fairy-orbit");
    orbit.classList.toggle("is-animated", shouldAnimate);
    orbit.classList.toggle("is-sleeping", isSleeping);
    if (offsetX || offsetY) {
      orbit.setAttribute("transform", `translate(${offsetX}, ${offsetY})`);
    }

    const total = Math.max(1, count);
    for (let index = 0; index < total; index += 1) {
      const angle = (Math.PI * 2 * index) / total;
      const x = roundPosition(Math.cos(angle) * radius);
      const y = roundPosition(Math.sin(angle) * radius);
      const fairy = createSvgElement("circle", "map-fairy");
      fairy.setAttribute("cx", String(x));
      fairy.setAttribute("cy", String(y));
      fairy.setAttribute("r", "1.6");
      orbit.append(fairy);
    }

    return orbit;
  }

  function updateLegend({ integrationDoctorPassed }) {
    if (!elements.legendFairyOrbit || !elements.legendFairyStatus) {
      return;
    }

    const shouldAnimate = integrationDoctorPassed === true;
    const statusLabel =
      integrationDoctorPassed === true
        ? "Integration doctor: passed"
        : integrationDoctorPassed === false
          ? "Integration doctor: not passed"
          : "Integration doctor: unknown";

    elements.legendFairyOrbit.classList.toggle("is-animated", shouldAnimate);
    elements.legendFairyOrbit.classList.toggle("is-sleeping", !shouldAnimate);
    elements.legendFairyStatus.textContent = statusLabel;
  }

  function setLegendVisibility(isVisible) {
    if (!elements.legend) {
      return;
    }

    elements.legend.hidden = !isVisible;
  }

  function showMessage({ title, copy, detail, detailIsCommand = false }) {
    if (!elements.message) {
      return;
    }

    elements.messageTitle.textContent = title ?? "";
    elements.messageCopy.textContent = copy ?? "";
    elements.messageDetail.innerHTML = "";

    if (detail) {
      if (detailIsCommand) {
        const code = document.createElement("code");
        code.textContent = detail;
        elements.messageDetail.append(code);
      } else {
        elements.messageDetail.textContent = detail;
      }
    }

    elements.message.hidden = false;
    elements.svg.hidden = true;
  }

  function hideMessage() {
    if (!elements.message) {
      return;
    }

    elements.message.hidden = true;
    elements.svg.hidden = false;
  }

  function clearSvg() {
    if (!elements.svg) {
      return;
    }

    while (elements.svg.firstChild) {
      elements.svg.removeChild(elements.svg.firstChild);
    }

    viewState.nodeElementsById.clear();
    viewState.edgeElements = [];
  }

  function updateSubtext() {
    if (!elements.headerSubtext) {
      return;
    }

    if (hasTarget()) {
      elements.headerSubtext.textContent = `Project ${appState.projectName} • Run ${appState.runId}`;
      return;
    }

    elements.headerSubtext.textContent = "Waiting for project + run.";
  }

  function updateMeta(snapshot) {
    if (!elements.meta) {
      return;
    }

    if (!snapshot) {
      setMetaValue(elements.meta.components, "—");
      setMetaValue(elements.meta.edges, "—");
      setMetaValue(elements.meta.baseSha, "—");
      return;
    }

    const hasComponents = Array.isArray(snapshot.components);
    const hasDeps = Array.isArray(snapshot.deps);
    const baseSha = snapshot.base_sha ?? snapshot.baseSha ?? null;

    setMetaValue(
      elements.meta.components,
      hasComponents ? String(snapshot.components.length) : "—",
    );
    setMetaValue(elements.meta.edges, hasDeps ? String(snapshot.deps.length) : "—");
    setMetaValue(elements.meta.baseSha, baseSha ? String(baseSha) : "—");
  }

  function setMetaValue(target, value) {
    if (!target) {
      return;
    }

    target.textContent = value;
  }

  // =============================================================================
  // GRAPH DATA
  // =============================================================================

  function buildComponentsById(components) {
    const componentsById = new Map();
    for (const component of components) {
      if (!component?.id) {
        continue;
      }
      componentsById.set(component.id, component);
    }
    return componentsById;
  }

  function buildDependencyMaps(componentsById, deps) {
    const depsOut = new Map();
    const depsIn = new Map();

    for (const id of componentsById.keys()) {
      depsOut.set(id, new Set());
      depsIn.set(id, new Set());
    }

    for (const edge of deps) {
      const from = edge?.from;
      const to = edge?.to;
      if (!from || !to) {
        continue;
      }
      if (!componentsById.has(from) || !componentsById.has(to)) {
        continue;
      }
      depsOut.get(from).add(to);
      depsIn.get(to).add(from);
    }

    return { depsOut, depsIn };
  }

  // =============================================================================
  // INSPECTOR + HIGHLIGHTING
  // =============================================================================

  function setSelectedComponentId(componentId) {
    viewState.selectedComponentId = componentId || null;
    updateInspectorForSelection();
    applyGraphHighlighting();
  }

  function clearSelection() {
    setSelectedComponentId(null);
  }

  function syncSelectionWithGraph() {
    const selectedId = viewState.selectedComponentId;
    const graphData = viewState.graphData;

    if (!selectedId || !graphData?.componentsById.has(selectedId)) {
      setSelectedComponentId(null);
      return;
    }

    updateInspectorForSelection();
    applyGraphHighlighting();
  }

  function updateInspectorForSelection() {
    if (!elements.inspector.panel || !elements.inspector.subtext) {
      return;
    }

    const selectedId = viewState.selectedComponentId;
    const graphData = viewState.graphData;

    if (!selectedId || !graphData?.componentsById.has(selectedId)) {
      elements.inspector.subtext.textContent = "Select a node to inspect.";
      setInspectorOpen(false);
      return;
    }

    const component = graphData.componentsById.get(selectedId);
    const roots = Array.isArray(component?.roots) ? component.roots : [];
    const dependencies = Array.from(graphData.depsOut.get(selectedId) ?? []).sort();
    const reverseDependencies = Array.from(graphData.depsIn.get(selectedId) ?? []).sort();
    const stats = getComponentStats(graphData.statsById, selectedId);

    elements.inspector.subtext.textContent = `Inspecting ${selectedId}`;
    setInspectorValue(elements.inspector.componentId, selectedId);
    renderInspectorList(elements.inspector.rootsList, roots, "No roots recorded.");
    renderInspectorList(elements.inspector.depsList, dependencies, "No direct deps.");
    renderInspectorList(
      elements.inspector.reverseDepsList,
      reverseDependencies,
      "No reverse deps.",
    );

    setInspectorValue(elements.inspector.stats.codeLoc, String(stats.code_loc));
    setInspectorValue(elements.inspector.stats.codeFiles, String(stats.code_files));
    setInspectorValue(elements.inspector.stats.unitTestFiles, String(stats.unit_test_files));
    setInspectorValue(
      elements.inspector.stats.integrationTestFiles,
      String(stats.integration_test_files),
    );
    setInspectorValue(elements.inspector.stats.e2eTestFiles, String(stats.e2e_test_files));

    setCommandValue(
      elements.inspector.commands.showComponent,
      `mycelium cp components show ${selectedId}`,
    );
    setCommandValue(elements.inspector.commands.showDependencies, `mycelium cp deps ${selectedId}`);
    setCommandValue(
      elements.inspector.commands.showReverseDependencies,
      `mycelium cp rdeps ${selectedId}`,
    );

    setInspectorOpen(true);
  }

  function setInspectorValue(target, value) {
    if (!target) {
      return;
    }
    target.textContent = value;
  }

  function renderInspectorList(listElement, values, emptyMessage) {
    if (!listElement) {
      return;
    }

    listElement.innerHTML = "";

    if (!values.length) {
      const empty = document.createElement("div");
      empty.className = "map-inspector-empty";
      empty.textContent = emptyMessage;
      listElement.append(empty);
      return;
    }

    for (const value of values) {
      const item = document.createElement("div");
      item.className = "map-inspector-item";
      item.textContent = String(value);
      listElement.append(item);
    }
  }

  function setCommandValue(command, value) {
    if (!command?.input) {
      return;
    }
    command.input.value = value;
  }

  function applyGraphHighlighting() {
    const highlight = buildHighlightContext();
    const shouldDim = viewState.shouldDimNonNeighbors;

    for (const [id, node] of viewState.nodeElementsById.entries()) {
      const isSelected = Boolean(highlight && id === highlight.selectedId);
      const isNeighbor = Boolean(highlight && highlight.neighborIds.has(id));
      node.classList.toggle("is-selected", isSelected);
      node.classList.toggle("is-neighbor", isNeighbor);
      node.classList.toggle(
        "is-dimmed",
        Boolean(highlight && shouldDim && !isSelected && !isNeighbor),
      );
    }

    for (const edge of viewState.edgeElements) {
      const isActive =
        Boolean(highlight) &&
        (edge.from === highlight.selectedId || edge.to === highlight.selectedId);
      edge.element.classList.toggle("is-active", isActive);
      edge.element.classList.toggle("is-dimmed", Boolean(highlight && shouldDim && !isActive));
    }
  }

  function buildHighlightContext() {
    const selectedId = viewState.selectedComponentId;
    const graphData = viewState.graphData;
    if (!selectedId || !graphData) {
      return null;
    }

    const neighborIds = new Set();
    for (const neighbor of graphData.depsOut.get(selectedId) ?? []) {
      neighborIds.add(neighbor);
    }
    for (const neighbor of graphData.depsIn.get(selectedId) ?? []) {
      neighborIds.add(neighbor);
    }
    neighborIds.delete(selectedId);

    return { selectedId, neighborIds };
  }

  function setInspectorOpen(isOpen) {
    if (!elements.inspector.panel || !elements.shell) {
      return;
    }

    elements.inspector.panel.hidden = !isOpen;
    elements.shell.classList.toggle("is-inspector-open", isOpen);
  }

  async function copyCommandToClipboard(commandText, fallbackInput) {
    if (!commandText) {
      return;
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(commandText);
        return;
      } catch (error) {
        // Fall back to selecting the input for manual copy.
      }
    }

    if (fallbackInput) {
      fallbackInput.focus();
      fallbackInput.select();
    }
  }

  // =============================================================================
  // LAYOUT
  // =============================================================================

  function buildGraphLayout({ components, deps, stageSize, statsById, shouldAnimateFairies }) {
    const nodesById = new Map();
    for (const component of components) {
      if (!component?.id) {
        continue;
      }
      nodesById.set(component.id, component);
    }

    const adjacency = buildAdjacencyMap(nodesById, deps);
    const centerId = pickCenterNode(adjacency);
    const ringData = buildRingData(adjacency, centerId);
    const positions = buildNodePositions(ringData, stageSize);
    const edges = buildEdgePaths(deps, nodesById, positions, statsById);
    const nodes = buildNodeDescriptors(
      ringData,
      nodesById,
      positions,
      adjacency,
      statsById,
      shouldAnimateFairies,
    );

    return { nodes, edges };
  }

  function buildAdjacencyMap(nodesById, deps) {
    const adjacency = new Map();
    for (const id of nodesById.keys()) {
      adjacency.set(id, new Set());
    }

    for (const edge of deps) {
      if (!edge?.from || !edge?.to) {
        continue;
      }
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) {
        continue;
      }
      adjacency.get(edge.from).add(edge.to);
      adjacency.get(edge.to).add(edge.from);
    }

    return adjacency;
  }

  function pickCenterNode(adjacency) {
    const ids = Array.from(adjacency.keys()).sort();
    let bestId = ids[0] ?? "";
    let bestDegree = -1;

    for (const id of ids) {
      const degree = adjacency.get(id)?.size ?? 0;
      if (degree > bestDegree) {
        bestDegree = degree;
        bestId = id;
        continue;
      }

      if (degree === bestDegree && id < bestId) {
        bestId = id;
      }
    }

    return bestId;
  }

  function buildRingData(adjacency, centerId) {
    const depthById = new Map();
    const orderedIds = Array.from(adjacency.keys()).sort();
    let maxDepth = -1;

    if (centerId) {
      maxDepth = Math.max(maxDepth, bfsAssignDepths(adjacency, centerId, 0, depthById));
    }

    for (const id of orderedIds) {
      if (depthById.has(id)) {
        continue;
      }
      maxDepth = Math.max(maxDepth, bfsAssignDepths(adjacency, id, maxDepth + 1, depthById));
    }

    const ringNodes = new Map();
    for (const id of orderedIds) {
      const depth = depthById.get(id) ?? 0;
      if (!ringNodes.has(depth)) {
        ringNodes.set(depth, []);
      }
      ringNodes.get(depth).push(id);
    }

    for (const ring of ringNodes.values()) {
      ring.sort();
    }

    return { ringNodes, depthById, maxDepth };
  }

  function bfsAssignDepths(adjacency, startId, depthOffset, depthById) {
    const queue = [startId];
    depthById.set(startId, depthOffset);
    let maxDepth = depthOffset;
    let index = 0;

    while (index < queue.length) {
      const current = queue[index++];
      const currentDepth = depthById.get(current) ?? depthOffset;
      const neighbors = Array.from(adjacency.get(current) ?? []).sort();

      for (const neighbor of neighbors) {
        if (depthById.has(neighbor)) {
          continue;
        }
        const nextDepth = currentDepth + 1;
        depthById.set(neighbor, nextDepth);
        queue.push(neighbor);
        if (nextDepth > maxDepth) {
          maxDepth = nextDepth;
        }
      }
    }

    return maxDepth;
  }

  function buildNodePositions(ringData, stageSize) {
    const { ringNodes, maxDepth } = ringData;
    const width = stageSize.width;
    const height = stageSize.height;
    const center = { x: width / 2, y: height / 2 };
    const maxRadius = Math.max(0, Math.min(width, height) / 2 - MAP_LAYOUT.stagePadding);
    const ringSpacing = maxDepth > 0 ? maxRadius / maxDepth : 0;
    const positions = new Map();

    const depths = Array.from(ringNodes.keys()).sort((a, b) => a - b);
    for (const depth of depths) {
      const ring = ringNodes.get(depth) ?? [];
      const radius = ringSpacing * depth;
      const angleStep = ring.length ? (Math.PI * 2) / ring.length : 0;
      const startAngle = -Math.PI / 2;

      ring.forEach((id, index) => {
        const angle = startAngle + angleStep * index;
        const x = center.x + Math.cos(angle) * radius;
        const y = center.y + Math.sin(angle) * radius;
        positions.set(id, { x: roundPosition(x), y: roundPosition(y), depth });
      });
    }

    return positions;
  }

  function buildEdgePaths(deps, nodesById, positions, statsById) {
    const edges = [];
    const seen = new Set();

    for (const edge of deps) {
      if (!edge?.from || !edge?.to) {
        continue;
      }
      if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) {
        continue;
      }
      if (!positions.has(edge.from) || !positions.has(edge.to)) {
        continue;
      }

      const key = buildEdgeKey(edge.from, edge.to);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const start = positions.get(edge.from);
      const end = positions.get(edge.to);
      const fromStats = getComponentStats(statsById, edge.from);
      const toStats = getComponentStats(statsById, edge.to);
      const edgeFootprint = (getCodeFootprint(fromStats) + getCodeFootprint(toStats)) / 2;
      const strokeWidth = computeHyphaWidth(edgeFootprint);
      const path = buildBezierPath(start, end, edge.from, edge.to);
      edges.push({ from: edge.from, to: edge.to, path, strokeWidth });
    }

    return edges;
  }

  function buildEdgeKey(from, to) {
    return from < to ? `${from}::${to}` : `${to}::${from}`;
  }

  function buildBezierPath(start, end, fromId, toId) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const perpX = -dy / distance;
    const perpY = dx / distance;
    const curveBase = Math.min(
      MAP_LAYOUT.edgeCurveMax,
      Math.max(MAP_LAYOUT.edgeCurveMin, distance * MAP_LAYOUT.edgeCurveScale),
    );
    const curveDirection = fromId < toId ? 1 : -1;
    const curve = curveBase * curveDirection;

    const control1 = {
      x: start.x + dx * 0.25 + perpX * curve,
      y: start.y + dy * 0.25 + perpY * curve,
    };
    const control2 = {
      x: start.x + dx * 0.75 + perpX * curve,
      y: start.y + dy * 0.75 + perpY * curve,
    };

    return `M ${start.x} ${start.y} C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${end.x} ${end.y}`;
  }

  function buildNodeDescriptors(
    ringData,
    nodesById,
    positions,
    adjacency,
    statsById,
    shouldAnimateFairies,
  ) {
    const nodes = [];
    const depths = Array.from(ringData.ringNodes.keys()).sort((a, b) => a - b);

    for (const depth of depths) {
      const ring = ringData.ringNodes.get(depth) ?? [];
      for (const id of ring) {
        const component = nodesById.get(id);
        const position = positions.get(id);
        if (!component || !position) {
          continue;
        }

        const stats = getComponentStats(statsById, id);
        const codeFootprint = getCodeFootprint(stats);
        const { coreRadius, glowRadius } = computeNodeRadii(codeFootprint);
        const hasMushroom = stats.unit_test_files > 0;
        const hasFairies = stats.integration_test_files + stats.e2e_test_files > 0;

        nodes.push({
          id,
          label: id,
          x: position.x,
          y: position.y,
          coreRadius,
          glowRadius,
          hasMushroom,
          hasFairies,
          shouldAnimateFairies,
          tooltip: buildNodeTooltip(component, adjacency.get(id), stats),
        });
      }
    }

    return nodes;
  }

  function buildNodeTooltip(component, neighbors, stats) {
    const lines = [component.id];
    if (component.kind) {
      lines.push(`Kind: ${component.kind}`);
    }
    if (neighbors) {
      lines.push(`Dependencies: ${neighbors.size}`);
    }
    if (Array.isArray(component.roots) && component.roots.length) {
      lines.push(`Roots: ${component.roots.join(", ")}`);
    }
    if (stats) {
      lines.push(`Code LOC: ${stats.code_loc}`);
      lines.push(`Code files: ${stats.code_files}`);
      lines.push(`Unit test files: ${stats.unit_test_files}`);
      lines.push(`Integration test files: ${stats.integration_test_files}`);
      lines.push(`E2E test files: ${stats.e2e_test_files}`);
    }

    return lines.join("\n");
  }

  // =============================================================================
  // SEMANTIC MAPPING
  // =============================================================================

  function normalizeStatsById(statsById) {
    const normalized = new Map();
    if (!statsById || typeof statsById !== "object") {
      return normalized;
    }

    for (const [id, stats] of Object.entries(statsById)) {
      normalized.set(id, normalizeComponentStats(stats));
    }

    return normalized;
  }

  function getComponentStats(statsById, componentId) {
    if (!statsById) {
      return buildEmptyStats();
    }

    if (statsById instanceof Map) {
      return statsById.get(componentId) ?? buildEmptyStats();
    }

    return normalizeComponentStats(statsById[componentId]);
  }

  function normalizeComponentStats(stats) {
    if (!stats || typeof stats !== "object") {
      return buildEmptyStats();
    }

    return {
      code_loc: normalizeCount(stats.code_loc),
      code_files: normalizeCount(stats.code_files),
      unit_test_files: normalizeCount(stats.unit_test_files),
      integration_test_files: normalizeCount(stats.integration_test_files),
      e2e_test_files: normalizeCount(stats.e2e_test_files),
    };
  }

  function buildEmptyStats() {
    return {
      code_loc: 0,
      code_files: 0,
      unit_test_files: 0,
      integration_test_files: 0,
      e2e_test_files: 0,
    };
  }

  function normalizeCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return 0;
    }
    return Math.round(number);
  }

  function getCodeFootprint(stats) {
    if (!stats) {
      return 0;
    }

    if (stats.code_loc > 0) {
      return stats.code_loc;
    }

    return stats.code_files;
  }

  function computeHyphaWidth(codeFootprint) {
    const weight = computeCodeWeight(codeFootprint);
    return clampValue(
      MAP_LAYOUT.hyphaStrokeMin,
      MAP_LAYOUT.hyphaStrokeMax,
      MAP_LAYOUT.hyphaStrokeBase + weight,
    );
  }

  function computeNodeRadii(codeFootprint) {
    const weight = computeCodeWeight(codeFootprint);
    const coreRadius = clampValue(
      MAP_LAYOUT.knotCoreMinRadius,
      MAP_LAYOUT.knotCoreMaxRadius,
      MAP_LAYOUT.knotCoreRadius + weight,
    );
    const glowRadius = clampValue(
      MAP_LAYOUT.knotGlowMinRadius,
      MAP_LAYOUT.knotGlowMaxRadius,
      MAP_LAYOUT.knotGlowRadius + weight * 1.6,
    );

    return { coreRadius, glowRadius };
  }

  function computeCodeWeight(codeFootprint) {
    const safeFootprint = Number.isFinite(codeFootprint) ? Math.max(0, codeFootprint) : 0;
    return Math.log10(1 + safeFootprint);
  }

  function clampValue(minValue, maxValue, value) {
    return Math.min(maxValue, Math.max(minValue, value));
  }

  // =============================================================================
  // UTILITIES
  // =============================================================================

  function scheduleResizeRender() {
    if (viewState.resizeFrameId !== null) {
      return;
    }

    viewState.resizeFrameId = window.requestAnimationFrame(() => {
      viewState.resizeFrameId = null;
      if (!viewState.snapshot) {
        return;
      }
      renderGraph(viewState.snapshot);
    });
  }

  function getStageSize() {
    if (!elements.stage) {
      return null;
    }

    const width = Math.max(0, elements.stage.clientWidth);
    const height = Math.max(0, elements.stage.clientHeight);
    if (!width || !height) {
      return null;
    }

    return { width, height };
  }

  function createSvgElement(tagName, className) {
    const element = document.createElementNS(SVG_NS, tagName);
    if (className) {
      element.setAttribute("class", className);
    }
    return element;
  }

  function extractBaseSha(error) {
    return findSha(error?.hint) ?? findSha(error?.message) ?? null;
  }

  function findSha(text) {
    if (!text || typeof text !== "string") {
      return null;
    }

    const match = text.match(/\b[0-9a-f]{7,40}\b/i);
    return match ? match[0] : null;
  }

  function roundPosition(value) {
    return Math.round(value * 10) / 10;
  }

  function hasTarget() {
    return Boolean(appState?.projectName && appState?.runId);
  }

  function toErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
