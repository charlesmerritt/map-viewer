/* ----------------------------------------------------------------
   zonal-stats.js — selected-polygon raster tools.

   Zones come from two places: built-in state/county polygons
   (boundary-layers.js) and user-drawn polygons (draw-tools.js). Both
   emit "boundary:selected". Statistics are computed by
   zonal-engine.js — client-side via geotiff.js where the browser can
   reach the pixels, or TiTiler's /cog/statistics for D2S tile layers.

   Clip-to-extent remains a stub for a future slice.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;

  let selectedBoundary = null;
  let mode = "stats";
  let chart = null;
  let running = false;

  function init() {
    const statsBtn = document.getElementById("zonal-open-stats");
    const clipBtn = document.getElementById("zonal-open-clip");
    const modal = document.getElementById("zonal-modal");

    State.on("boundary:selected", (boundary) => {
      selectedBoundary = boundary;
      renderSelectionPanel(boundary);
    });
    State.on("boundary:cleared", () => {
      if (selectedBoundary?.kind !== "drawn") return;
      selectedBoundary = null;
      document.getElementById("zonal-selection")?.classList.add("hidden");
      document.getElementById("zonal-empty")?.classList.remove("hidden");
    });

    statsBtn?.addEventListener("click", () => openModal("stats"));
    clipBtn?.addEventListener("click", () => openModal("clip"));
    modal?.querySelectorAll("[data-close-zonal-modal]").forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });
    document.getElementById("zonal-run-action")?.addEventListener("click", runAction);
  }

  function boundaryMeta(boundary) {
    if (boundary.kind === "county") return `COUNTY ${boundary.geoid || ""}`;
    if (boundary.kind === "state") return `STATE ${boundary.stusps || boundary.statefp || ""}`;
    return "DRAWN POLYGON";
  }

  function renderSelectionPanel(boundary) {
    document.getElementById("zonal-empty")?.classList.add("hidden");
    document.getElementById("zonal-selection")?.classList.remove("hidden");
    document.getElementById("zonal-selected-name").textContent = boundary.name || "Selected polygon";
    document.getElementById("zonal-selected-meta").textContent = boundaryMeta(boundary);
  }

  function openModal(nextMode) {
    selectedBoundary = selectedBoundary || window.BoundaryLayers?.getSelectedBoundary?.();
    if (!selectedBoundary) {
      State.toast("Draw a polygon or click a visible built-in state/county polygon first.", "error");
      return;
    }

    mode = nextMode;
    resetResults();
    populateRasterLayerSelect();

    const isClipMode = mode === "clip";
    document.getElementById("zonal-modal-title").textContent = isClipMode
      ? "Clip raster to polygon extent"
      : "Summarize raster by polygon";
    document.getElementById("zonal-modal-zone").textContent = `${selectedBoundary.name} (${selectedBoundary.kind})`;
    document.getElementById("zonal-modal-hint").textContent = isClipMode
      ? "Stub: clipping to the selected polygon extent is not wired to processing yet."
      : "Statistics are computed from the raster pixels whose centers fall inside the polygon. " +
        "Large rasters are sampled from COG overviews to stay responsive.";
    document.getElementById("zonal-run-action").textContent = isClipMode
      ? "Stub clip"
      : "Compute statistics";
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

  async function runAction() {
    const layer = selectedRasterLayer();
    if (!layer) {
      State.toast("Choose a raster layer first.", "error");
      return;
    }

    if (mode === "clip") {
      renderRows("Extent clipping is stubbed", [
        ["Selected zone", selectedBoundary.name],
        ["Raster layer", layer.name],
        ["Planned behavior", "Create/display a raster clipped to this polygon extent"],
      ]);
      State.toast("Clip-to-extent is stubbed for now.", "info");
      return;
    }

    if (running) return;
    running = true;
    const runBtn = document.getElementById("zonal-run-action");
    runBtn.disabled = true;
    resetResults();
    document.getElementById("zonal-status").textContent = "Computing statistics…";

    try {
      const { stats, meta } = await window.ZonalEngine.compute(layer, selectedBoundary.geometry);
      renderStatsResult(layer, stats, meta);
    } catch (err) {
      console.error("Zonal statistics failed", err);
      document.getElementById("zonal-status").textContent = "Failed: " + (err.message || err);
      State.toast(err.message || String(err), "error");
    } finally {
      running = false;
      runBtn.disabled = false;
    }
  }

  function renderStatsResult(layer, stats, meta) {
    if (!stats || stats.count === 0) {
      const nodataNote = stats && stats.nodataCount > 0
        ? ` (${formatNumber(stats.nodataCount)} nodata pixels inside the polygon)`
        : "";
      document.getElementById("zonal-status").textContent =
        "No valid raster pixels inside this polygon" + nodataNote + ".";
      return;
    }

    const rows = [
      ["Valid pixels", formatNumber(stats.count)],
      ["Mean", formatNumber(stats.mean)],
      ["Min", formatNumber(stats.min)],
      ["Max", formatNumber(stats.max)],
      ["Sum", formatNumber(stats.sum)],
      ["Std. dev.", formatNumber(stats.std)],
    ];
    if (stats.nodataCount != null) rows.push(["Nodata pixels", formatNumber(stats.nodataCount)]);
    if (meta.median != null) rows.push(["Median", formatNumber(meta.median)]);

    const notes = [];
    if (meta.timestepLabel) notes.push(`timestep ${meta.timestepLabel}`);
    if (meta.method === "titiler") {
      notes.push("computed by TiTiler");
    } else {
      notes.push("computed in the browser");
      if (meta.approximate) {
        notes.push(`sampled from overview level ${meta.overviewLevel} (~${formatNumber(meta.pixelSize)} CRS units/pixel)`);
      }
    }
    renderRows(`${layer.name} — ${notes.join(", ")}`, rows);
    renderHistogram(layer.name, stats.histogram);
  }

  function formatNumber(value) {
    if (value == null || Number.isNaN(value)) return "—";
    if (Number.isInteger(value)) return value.toLocaleString();
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) return value.toExponential(4);
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function selectedRasterLayer() {
    const id = document.getElementById("zonal-layer-select").value;
    return id ? State.getLayer(id) : null;
  }

  function resetResults() {
    document.getElementById("zonal-results").classList.add("hidden");
    document.getElementById("zonal-results-body").innerHTML = "";
    document.getElementById("zonal-status").textContent = "";
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderRows(status, rows) {
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

  function renderHistogram(layerName, histogram) {
    if (typeof Chart === "undefined" || !histogram || !histogram.counts?.length) return;
    const canvas = document.getElementById("zonal-chart");
    if (chart) chart.destroy();
    const labels = histogram.counts.map((_, i) => {
      const lo = histogram.edges[i];
      const hi = histogram.edges[i + 1];
      return hi == null ? formatNumber(lo) : `${formatNumber(lo)} – ${formatNumber(hi)}`;
    });
    chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: `${layerName} — pixel value distribution`,
          data: histogram.counts,
          backgroundColor: "#6ab048",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#e6edf3" } },
        },
        scales: {
          x: { ticks: { color: "#9aa4b2", maxRotation: 60, autoSkip: true }, grid: { color: "#262d3a" } },
          y: { ticks: { color: "#9aa4b2" }, grid: { color: "#262d3a" } },
        },
      },
    });
  }

  window.ZonalStats = { init };
})();
