// Map view renderer for the Mycelium UI.
// Purpose: render a deterministic dependency map as a mycelium network.
// Usage: created by app.js and driven via setActive/reset/refresh.

const SVG_NS = "http://www.w3.org/2000/svg";

const MAP_LAYOUT = {
  stagePadding: 64,
  edgeCurveScale: 0.25,
  edgeCurveMin: 22,
  edgeCurveMax: 120,
  knotGlowRadius: 10,
  knotCoreRadius: 4,
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
    message: null,
    messageTitle: null,
    messageCopy: null,
    messageDetail: null,
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

    const stage = document.createElement("div");
    stage.className = "map-stage";

    const svg = createSvgElement("svg", "map-graph");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Codebase dependency map");

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
    stage.append(svg, message);

    shell.append(header, stage);
    container.append(shell);

    elements.shell = shell;
    elements.headerSubtext = subtext;
    elements.meta.components = componentsMeta.value;
    elements.meta.edges = edgesMeta.value;
    elements.meta.baseSha = baseShaMeta.value;
    elements.stage = stage;
    elements.svg = svg;
    elements.message = message;
    elements.messageTitle = messageTitle;
    elements.messageCopy = messageCopy;
    elements.messageDetail = messageDetail;
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


  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    viewState.snapshot = null;
    viewState.isLoading = false;
    viewState.requestId += 1;
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
    clearSvg();
    showMessage({
      title: "Map view",
      copy: "Choose a project and run to load the dependency map.",
      detail: "",
    });
  }

  function renderLoadingState() {
    updateSubtext();
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
    if (baseSha) {
      setMetaValue(elements.meta.baseSha, baseSha);
    }
    clearSvg();

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

    if (!components.length) {
      clearSvg();
      showMessage({
        title: "No components found",
        copy: "The control-plane model has no components to visualize.",
        detail: "",
      });
      return;
    }

    hideMessage();
    clearSvg();
    renderGraphSvg({ components, deps, stageSize });
  }

  function renderGraphSvg({ components, deps, stageSize }) {
    const width = stageSize.width;
    const height = stageSize.height;

    elements.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.svg.setAttribute("width", String(width));
    elements.svg.setAttribute("height", String(height));

    const graphData = buildGraphLayout(components, deps, stageSize);

    const edgesGroup = createSvgElement("g", "map-edges");
    for (const edge of graphData.edges) {
      const path = createSvgElement("path", "map-hypha");
      path.setAttribute("d", edge.path);
      edgesGroup.append(path);
    }

    const nodesGroup = createSvgElement("g", "map-nodes");
    for (const node of graphData.nodes) {
      const nodeGroup = createSvgElement("g", "map-node");
      nodeGroup.setAttribute("transform", `translate(${node.x}, ${node.y})`);
      nodeGroup.setAttribute("data-node-id", node.id);

      const tooltip = createSvgElement("title");
      tooltip.textContent = node.tooltip;

      const glow = createSvgElement("circle", "map-knot-glow");
      glow.setAttribute("r", String(MAP_LAYOUT.knotGlowRadius));

      const core = createSvgElement("circle", "map-knot-core");
      core.setAttribute("r", String(MAP_LAYOUT.knotCoreRadius));

      const label = createSvgElement("text", "map-label");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("y", String(MAP_LAYOUT.labelOffset));
      label.textContent = node.label;

      nodeGroup.append(tooltip, glow, core, label);
      nodesGroup.append(nodeGroup);
    }

    elements.svg.append(edgesGroup, nodesGroup);
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

    setMetaValue(elements.meta.components, hasComponents ? String(snapshot.components.length) : "—");
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
  // LAYOUT
  // =============================================================================

  function buildGraphLayout(components, deps, stageSize) {
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
    const edges = buildEdgePaths(deps, nodesById, positions);
    const nodes = buildNodeDescriptors(ringData, nodesById, positions, adjacency);

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

  function buildEdgePaths(deps, nodesById, positions) {
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
      const path = buildBezierPath(start, end, edge.from, edge.to);
      edges.push({ from: edge.from, to: edge.to, path });
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

  function buildNodeDescriptors(ringData, nodesById, positions, adjacency) {
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

        nodes.push({
          id,
          label: id,
          x: position.x,
          y: position.y,
          tooltip: buildNodeTooltip(component, adjacency.get(id)),
        });
      }
    }

    return nodes;
  }

  function buildNodeTooltip(component, neighbors) {
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

    return lines.join("\n");
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
