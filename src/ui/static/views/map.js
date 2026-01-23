// Map view placeholder.
// Purpose: render a lightweight placeholder until the Map visualizer is implemented.
// Usage: created by app.js during initialization.

export function createMapView() {
  const container = document.getElementById("view-map");

  return {
    init,
  };


  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    if (!container) {
      return;
    }

    renderPlaceholder();
  }


  // =============================================================================
  // RENDERING
  // =============================================================================

  function renderPlaceholder() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "placeholder-title";
    title.textContent = "Map View";

    const copy = document.createElement("p");
    copy.className = "placeholder-copy";
    copy.textContent = "Dependency graph explorer coming soon.";

    container.append(title, copy);
  }
}
