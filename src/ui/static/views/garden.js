// Garden view (Grove bridge)
// Purpose: mount the Mycelium Grove visualiser in place of the legacy garden renderer.

const GROVE_MODULE_PATH = "../grove/mycelium-grove.mjs";
const GROVE_ASSET_BASE = "/grove";

export function createGardenView({ container, fetchApi, appState, loadGroveModule } = {}) {
  const resolvedContainer = container ?? resolveGardenContainer();

  const viewState = {
    isActive: false,
    pollingPaused: false,
    hostEl: null,
    controller: null,
    isLoading: false,
    errorEl: null,
    latestSummary: null,
    target: readTargetFromAppState(appState),
    mountId: 0,
    modulePromise: null,
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
    if (!resolvedContainer) return;

    resolvedContainer.classList?.remove("view-placeholder");
    resolvedContainer.classList?.add("garden-view");

    // The host is created lazily when the tab is first activated.
    ensureErrorElement();
  }

  // =============================================================================
  // VIEW STATE
  // =============================================================================

  function reset() {
    if (!resolvedContainer) return;

    syncTargetFromAppState();
    viewState.latestSummary = null;

    if (viewState.controller) {
      viewState.controller.setTarget(viewState.target.projectName, viewState.target.runId);
    }
  }

  function onSummary(summary) {
    if (!resolvedContainer) return;

    viewState.latestSummary = summary;

    if (viewState.controller) {
      viewState.controller.setSummary(summary);
      return;
    }

    if (viewState.isActive) {
      void ensureMounted();
    }
  }

  function onSelectionChanged() {
    // No-op (Grove does not currently bind task selection).
  }

  function setActive(isActive) {
    viewState.isActive = !!isActive;
    if (!resolvedContainer) return;

    if (viewState.isActive) {
      void ensureMounted();
      viewState.controller?.setActive(true);
      return;
    }

    teardownGrove();
  }

  function setPollingPaused(paused) {
    viewState.pollingPaused = !!paused;
    viewState.controller?.setPollingPaused(viewState.pollingPaused);
  }

  async function refresh() {
    if (!viewState.isActive) return;

    if (!viewState.controller) {
      await ensureMounted();
    }

    viewState.controller?.refresh?.();
  }

  // =============================================================================
  // GROVE MOUNTING
  // =============================================================================

  async function ensureMounted() {
    if (!resolvedContainer) return;
    if (!viewState.isActive) return;
    if (viewState.controller || viewState.isLoading) return;

    viewState.isLoading = true;
    const mountId = ++viewState.mountId;

    try {
      clearError();
      syncTargetFromAppState();

      const host = ensureHostElement();
      if (!host) {
        throw new Error("Grove host element could not be created.");
      }

      const modulePromise =
        viewState.modulePromise ??
        (loadGroveModule ? loadGroveModule() : import(GROVE_MODULE_PATH));
      viewState.modulePromise = modulePromise;

      const mod = await modulePromise;
      if (!mod?.mountMyceliumGrove) {
        throw new Error("Grove bundle loaded, but mountMyceliumGrove export was not found.");
      }

      if (!viewState.isActive || mountId !== viewState.mountId) {
        return;
      }

      viewState.controller = mod.mountMyceliumGrove(host, {
        projectName: viewState.target.projectName,
        runId: viewState.target.runId,
        pollingPaused: viewState.pollingPaused,
        active: viewState.isActive,
        assetBase: GROVE_ASSET_BASE,
        fetchApi,
      });

      if (viewState.latestSummary) {
        viewState.controller.setSummary(viewState.latestSummary);
      }
    } catch (err) {
      showError(toErrorMessage(err));
    } finally {
      viewState.isLoading = false;
    }
  }

  function teardownGrove() {
    viewState.mountId += 1;

    if (viewState.controller) {
      viewState.controller.unmount();
      viewState.controller = null;
    }
  }

  // =============================================================================
  // DOM HELPERS
  // =============================================================================

  function ensureHostElement() {
    if (viewState.hostEl) return viewState.hostEl;

    const doc = resolveDocument(resolvedContainer);
    if (!doc?.createElement) return null;

    const host = doc.createElement("div");
    host.className = "grove-host";

    if (viewState.errorEl && resolvedContainer.insertBefore) {
      resolvedContainer.insertBefore(host, viewState.errorEl);
    } else {
      resolvedContainer.appendChild(host);
    }

    viewState.hostEl = host;
    return host;
  }

  function ensureErrorElement() {
    if (!resolvedContainer) return;

    const existing = resolvedContainer.querySelector?.(".grove-error") ?? null;
    if (existing) {
      viewState.errorEl = existing;
      return;
    }

    const doc = resolveDocument(resolvedContainer);
    if (!doc?.createElement) return;

    const err = doc.createElement("div");
    err.className = "grove-error hidden";
    resolvedContainer.appendChild(err);
    viewState.errorEl = err;
  }

  function resolveDocument(element) {
    return element?.ownerDocument ?? globalThis.document ?? null;
  }

  function resolveGardenContainer() {
    if (!globalThis.document?.getElementById) return null;
    return globalThis.document.getElementById("view-garden");
  }

  // =============================================================================
  // STATE SYNC
  // =============================================================================

  function readTargetFromAppState(state) {
    return {
      projectName: state?.projectName ?? "",
      runId: state?.runId ?? "",
    };
  }

  function syncTargetFromAppState() {
    if (!appState) return;
    viewState.target = readTargetFromAppState(appState);
  }

  // =============================================================================
  // ERROR HANDLING
  // =============================================================================

  function showError(message) {
    if (!viewState.errorEl) return;
    viewState.errorEl.textContent = message;
    viewState.errorEl.classList.remove("hidden");
  }

  function clearError() {
    if (!viewState.errorEl) return;
    viewState.errorEl.textContent = "";
    viewState.errorEl.classList.add("hidden");
  }

  function toErrorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
