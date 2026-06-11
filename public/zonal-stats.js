/* ----------------------------------------------------------------
   zonal-stats.js — UI scaffold for selected-polygon raster tools.

   This file intentionally stubs the processing logic. The current slice keeps
   polygon selection, the zonal tools modal, layer selection, and Chart.js wiring
   without attempting client-side/server-side zonal statistics or clipping yet.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;

  let selectedBoundary = null;
  let mode = "stats";
  let chart = null;

  function init() {
    const statsBtn = document.getElementById("zonal-open-stats");
    const clipBtn = document.getElementById("zonal-open-clip");
    const modal = document.getElementById("zonal-modal");

    State.on("boundary:selected", (boundary) => {
      selectedBoundary = boundary;
      renderSelectionPanel(boundary);
    });

    statsBtn?.addEventListener("click", () => openModal("stats"));
    clipBtn?.addEventListener("click", () => openModal("clip"));
    modal?.querySelectorAll("[data-close-zonal-modal]").forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });
    document.getElementById("zonal-run-action")?.addEventListener("click", runStubAction);
  }

  function renderSelectionPanel(boundary) {
    document.getElementById("zonal-empty")?.classList.add("hidden");
    document.getElementById("zonal-selection")?.classList.remove("hidden");
    document.getElementById("zonal-selected-name").textContent = boundary.name || "Selected polygon";
    document.getElementById("zonal-selected-meta").textContent = boundary.kind === "county"
      ? `COUNTY ${boundary.geoid || ""}`
      : `STATE ${boundary.stusps || boundary.statefp || ""}`;
  }

  function openModal(nextMode) {
    selectedBoundary = selectedBoundary || window.BoundaryLayers?.getSelectedBoundary?.();
    if (!selectedBoundary) {
      State.toast("Click a visible built-in state or county polygon first.", "error");
      return;
    }

    mode = nextMode;
    resetStubResults();
    populateRasterLayerSelect();

    const isClipMode = mode === "clip";
    document.getElementById("zonal-modal-title").textContent = isClipMode
      ? "Clip raster to polygon extent"
      : "Summarize raster by polygon";
    document.getElementById("zonal-modal-zone").textContent = `${selectedBoundary.name} (${selectedBoundary.kind})`;
    document.getElementById("zonal-modal-hint").textContent = isClipMode
      ? "Stub: clipping to the selected polygon extent is not wired to processing yet."
      : "Stub: zonal statistics processing is not implemented yet; this modal is ready for the future backend.";
    document.getElementById("zonal-run-action").textContent = isClipMode
      ? "Stub clip"
      : "Stub summarize";
    document.getElementById("zonal-modal").classList.remove("hidden");
  }

  function closeModal() {
    document.getElementById("zonal-modal").classList.add("hidden");
  }

  function populateRasterLayerSelect() {
    const select = document.getElementById("zonal-layer-select");
    select.innerHTML = "";

    const layers = rasterLayers();
    if (layers.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No raster layers available";
      select.appendChild(option);
      return;
    }

    layers.forEach((layer) => {
      const option = document.createElement("option");
      option.value = layer.id;
      option.textContent = layer.name;
      select.appendChild(option);
    });
  }

  function rasterLayers() {
    return State.getLayers().filter((layer) => layer.type === "cog" || layer.type === "d2s-raster");
  }

  function runStubAction() {
    const layer = selectedRasterLayer();
    if (!layer) {
      State.toast("Choose a raster layer first.", "error");
      return;
    }

    if (mode === "clip") {
      renderStubMessage("Extent clipping is stubbed", [
        ["Selected zone", selectedBoundary.name],
        ["Raster layer", layer.name],
        ["Planned behavior", "Create/display a raster clipped to this polygon extent"],
      ]);
      State.toast("Clip-to-extent is stubbed for now.", "info");
      return;
    }

    renderStubMessage("Zonal statistics are stubbed", [
      ["Selected zone", selectedBoundary.name],
      ["Raster layer", layer.name],
      ["Planned statistics", "count, mean, min, max, sum, nodata count, stddev"],
    ]);
    renderChartPlaceholder(layer.name);
    State.toast("Zonal statistics are stubbed for now.", "info");
  }

  function selectedRasterLayer() {
    const id = document.getElementById("zonal-layer-select").value;
    return id ? State.getLayer(id) : null;
  }

  function resetStubResults() {
    document.getElementById("zonal-results").classList.add("hidden");
    document.getElementById("zonal-results-body").innerHTML = "";
    document.getElementById("zonal-status").textContent = "";
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderStubMessage(status, rows) {
    document.getElementById("zonal-status").textContent = status;
    const tbody = document.getElementById("zonal-results-body");
    tbody.innerHTML = "";
    rows.forEach(([label, value]) => {
      const row = document.createElement("tr");
      const keyCell = document.createElement("td");
      const valueCell = document.createElement("td");
      keyCell.textContent = label;
      valueCell.textContent = value;
      row.appendChild(keyCell);
      row.appendChild(valueCell);
      tbody.appendChild(row);
    });
    document.getElementById("zonal-results").classList.remove("hidden");
  }

  function renderChartPlaceholder(layerName) {
    if (typeof Chart === "undefined") return;
    const canvas = document.getElementById("zonal-chart");
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: ["Count", "Mean", "Min", "Max", "Std. dev."],
        datasets: [{
          label: `${layerName} — pending backend`,
          data: [0, 0, 0, 0, 0],
          backgroundColor: ["#374151", "#374151", "#374151", "#374151", "#374151"],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#e6edf3" } },
        },
        scales: {
          x: { ticks: { color: "#9aa4b2" }, grid: { color: "#262d3a" } },
          y: { ticks: { color: "#9aa4b2" }, grid: { color: "#262d3a" } },
        },
      },
    });
  }

  window.ZonalStats = { init };
})();
