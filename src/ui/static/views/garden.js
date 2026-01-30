// Garden view (Grove bridge)
// Purpose: mount the Mycelium Grove visualiser in place of the legacy garden renderer.

const GROVE_MODULE_PATH = "../grove/mycelium-grove.mjs";
const GROVE_ASSET_BASE = "/grove";

export function createGardenView({ appState, actions: _actions, fetchApi }) {
  const container = document.getElementById("view-garden");

  const viewState = {
    isActive: true,
    pollingPaused: false,
    hostEl: null,
    controller: null,
    isLoading: false,
    errorEl: null,
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

  function init() {
    if (!container) return;

    // The host is created lazily when the tab is first activated.
    viewState.errorEl = container.querySelector(".grove-error") || null;
    if (!viewState.errorEl) {
      const err = document.createElement("div");
      err.className = "grove-error hidden";
      container.appendChild(err);
      viewState.errorEl = err;
    }
  }

  function reset() {
    if (viewState.controller) {
      viewState.controller.reset();
      viewState.controller.setTarget(appState.projectName, appState.runId);
    }
  }

  function onSummary(summary) {
    if (!viewState.controller) {
      // Only mount on first summary when active; avoids loading Grove unnecessarily.
      if (viewState.isActive) {
        void ensureMounted();
      } else {
        return;
      }
    }

    viewState.controller?.setSummary(summary);
  }

  function onSelectionChanged() {
    // No-op (Grove does not currently bind task selection).
  }

  function setActive(isActive) {
    viewState.isActive = !!isActive;
    if (isActive) {
      void ensureMounted();
    }
    viewState.controller?.setActive(viewState.isActive);
  }

  function setPollingPaused(paused) {
    viewState.pollingPaused = !!paused;
    viewState.controller?.setPollingPaused(viewState.pollingPaused);
  }

  async function refresh() {
    viewState.controller?.refresh?.();
  }

  async function ensureMounted() {
    if (!container) return;
    if (viewState.controller || viewState.isLoading) return;

    viewState.isLoading = true;
    try {
      clearError();

      if (!viewState.hostEl) {
        const host = document.createElement("div");
        host.className = "grove-host";
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.minHeight = "420px";
        container.appendChild(host);
        viewState.hostEl = host;
      }

      const mod = await import(GROVE_MODULE_PATH);
      if (!mod?.mountMyceliumGrove) {
        throw new Error("Grove bundle loaded, but mountMyceliumGrove export was not found.");
      }

      viewState.controller = mod.mountMyceliumGrove(viewState.hostEl, {
        projectName: appState.projectName,
        runId: appState.runId,
        pollingPaused: viewState.pollingPaused,
        active: viewState.isActive,
        assetBase: GROVE_ASSET_BASE,
        fetchApi,
      });
    } catch (err) {
      showError(toErrorMessage(err));
    } finally {
      viewState.isLoading = false;
    }
  }

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
