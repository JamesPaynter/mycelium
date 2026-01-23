// Garden view placeholder.
// Purpose: render a lightweight placeholder until the Garden visualizer is implemented.
// Usage: created by app.js during initialization.

export function createGardenView() {
  const container = document.getElementById("view-garden");

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
    title.textContent = "Garden View";

    const copy = document.createElement("p");
    copy.className = "placeholder-copy";
    copy.textContent = "Mushroom growth visualization coming soon.";

    container.append(title, copy);
  }
}
