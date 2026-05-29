/* ----------------------------------------------------------------
   app.js — bootstrap & UI wiring.

   - Initializes MapLibre GL JS map and base-layer switcher.
   - Loads built-in layer catalog from layers.json.
   - Wires sidebar, add-layer modal, and toasts.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;
  const Layers = window.Layers;

  // ---- Base layers ----

  const BASE_LAYERS = [
    {
      name: "Carto Dark",
      url: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    },
    {
      name: "OpenStreetMap",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    },
    {
      name: "Esri World Imagery",
      url:
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
      maxZoom: 19,
    },
    {
      name: "OpenTopoMap",
      url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution:
        'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
    },
    {
      name: "Carto Voyager",
      url: "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    },
  ];

  let currentBaseName = null;

  function initMap() {
    const map = new maplibregl.Map({
      container: "map",
      center: [-82.5, 37.5], // Roughly Eastern US, PERSEUS region (lng, lat)
      zoom: 5,
      style: {
        version: 8,
        sources: {},
        layers: [],
      },
    });
    map.addControl(new maplibregl.NavigationControl());
    State.setMap(map);
    
    // Wait for map to load before adding basemap
    map.on('load', () => {
      setBaseLayer(BASE_LAYERS[0].name);
    });
    
    return map;
  }

  function moveBasemapToBottom(map) {
    const layers = map.getStyle().layers;
    if (!layers || layers.length < 2) return;
    const firstNonBase = layers.find((l) => l.id !== "basemap");
    if (firstNonBase) {
      map.moveLayer("basemap", firstNonBase.id);
    }
  }

  function setBaseLayer(name) {
    const map = State.getMap();
    const def = BASE_LAYERS.find((b) => b.name === name) || BASE_LAYERS[0];
    
    // Remove old basemap source/layer if exists
    if (currentBaseName && map.getSource("basemap")) {
      if (map.getLayer("basemap")) map.removeLayer("basemap");
      map.removeSource("basemap");
    }
    
    currentBaseName = name;
    
    // Add new basemap as raster source
    map.addSource("basemap", {
      type: "raster",
      tiles: [def.url],
      tileSize: 256,
      attribution: def.attribution,
    });
    
    map.addLayer({
      id: "basemap",
      type: "raster",
      source: "basemap",
      minZoom: 0,
      maxZoom: def.maxZoom,
    });
    
    moveBasemapToBottom(map);
  }

  function renderBasemapSelect() {
    const sel = document.getElementById("basemap-select");
    sel.innerHTML = "";
    BASE_LAYERS.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.name;
      opt.textContent = b.name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => setBaseLayer(e.target.value));
  }

  // ---- Layer list rendering ----

  function renderLayerList() {
    const root = document.getElementById("layer-list");
    const empty = document.getElementById("layer-empty");
    root.innerHTML = "";

    const layers = State.getLayers().slice().reverse(); // top-most first
    empty.style.display = layers.length === 0 ? "block" : "none";

    layers.forEach((layer) => {
      const card = document.createElement("li");
      card.className = "layer-card";
      card.draggable = true;
      card.dataset.layerId = layer.id;
      card.addEventListener("dragstart", onLayerDragStart);
      card.addEventListener("dragover", onLayerDragOver);
      card.addEventListener("dragleave", onLayerDragLeave);
      card.addEventListener("drop", onLayerDrop);
      card.addEventListener("dragend", onLayerDragEnd);

      const row = document.createElement("div");
      row.className = "layer-row";

      const toggle = document.createElement("label");
      toggle.className = "layer-toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!layer.visible;
      cb.addEventListener("change", () =>
        Layers.setLayerVisible(layer, cb.checked)
      );
      toggle.appendChild(cb);
      row.appendChild(toggle);

      const name = document.createElement("div");
      name.className = "layer-name";
      name.title = layer.name;
      name.textContent = layer.name;
      row.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "layer-meta";
      meta.textContent = (layer.type === "cog" || layer.type === "d2s-raster") ? "RASTER" : "VECTOR";
      row.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "layer-actions";
      const zoomBtn = mkIconBtn("⤢", "Zoom to layer", () => {
        const bounds = layer.__bounds;
        if (bounds && bounds.length === 4) {
          State.getMap().fitBounds(bounds, { padding: 40 });
        }
      });
      actions.appendChild(zoomBtn);

      const removeBtn = mkIconBtn("×", "Remove layer", () => {
        Layers.removeLayer(layer);
      });
      removeBtn.style.color = "#ef4444";
      actions.appendChild(removeBtn);
      row.appendChild(actions);

      card.appendChild(row);

      // Opacity row
      const opacityRow = document.createElement("div");
      opacityRow.className = "layer-opacity";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.05";
      slider.value = String(layer.opacity ?? 1);
      const val = document.createElement("span");
      val.className = "opacity-val";
      val.textContent = `${Math.round((layer.opacity ?? 1) * 100)}%`;
      slider.addEventListener("input", (e) => {
        const v = Number(e.target.value);
        val.textContent = `${Math.round(v * 100)}%`;
        Layers.setLayerOpacity(layer, v);
      });
      opacityRow.appendChild(slider);
      opacityRow.appendChild(val);
      card.appendChild(opacityRow);

      // Colormap selector for d2s-raster layers
      if (layer.type === "d2s-raster" && layer.cogUrl && layer.vizOptions) {
        const cmRow = document.createElement("div");
        cmRow.className = "layer-opacity";
        cmRow.style.alignItems = "center";
        const cmLabel = document.createElement("span");
        cmLabel.className = "opacity-val";
        cmLabel.style.minWidth = "auto";
        cmLabel.style.marginRight = "6px";
        cmLabel.textContent = "Colormap";
        const cmSelect = document.createElement("select");
        cmSelect.className = "layer-colormap-select";
        const colormaps = [
          { value: "", label: "Grayscale" },
          { value: "viridis", label: "viridis" },
          { value: "magma", label: "magma" },
          { value: "inferno", label: "inferno" },
          { value: "plasma", label: "plasma" },
          { value: "cividis", label: "cividis" },
          { value: "Greens", label: "Greens" },
          { value: "YlGn", label: "YlGn" },
          { value: "RdYlGn", label: "RdYlGn" },
          { value: "Spectral", label: "Spectral" },
          { value: "terrain", label: "terrain" },
          { value: "turbo", label: "turbo" },
          { value: "jet", label: "jet" },
        ];
        colormaps.forEach(c => {
          const opt = document.createElement("option");
          opt.value = c.value;
          opt.textContent = c.label;
          if (c.value === (layer.vizOptions.colormap_name || "")) opt.selected = true;
          cmSelect.appendChild(opt);
        });
        cmSelect.addEventListener("change", () => {
          Layers.setLayerColormap(layer, cmSelect.value || null);
        });
        cmRow.appendChild(cmLabel);
        cmRow.appendChild(cmSelect);
        card.appendChild(cmRow);

        const scalerRow = document.createElement("div");
        scalerRow.className = "layer-opacity";
        scalerRow.style.alignItems = "center";
        const scalerLabel = document.createElement("span");
        scalerLabel.className = "opacity-val";
        scalerLabel.style.minWidth = "auto";
        scalerLabel.style.marginRight = "6px";
        scalerLabel.textContent = "Scaler";
        const scalerSelect = document.createElement("select");
        scalerSelect.className = "layer-colormap-select";
        const scalers = [
          { value: "", label: "Default" },
          { value: "nearest", label: "nearest" },
          { value: "bilinear", label: "bilinear" },
          { value: "cubic", label: "cubic" },
          { value: "cubic_spline", label: "cubic spline" },
          { value: "lanczos", label: "lanczos" },
          { value: "average", label: "average" },
          { value: "mode", label: "mode" },
          { value: "max", label: "max" },
          { value: "min", label: "min" },
          { value: "med", label: "median" },
          { value: "q1", label: "q1" },
          { value: "q3", label: "q3" },
        ];
        scalers.forEach(s => {
          const opt = document.createElement("option");
          opt.value = s.value;
          opt.textContent = s.label;
          if (s.value === (layer.vizOptions.resampling || "")) opt.selected = true;
          scalerSelect.appendChild(opt);
        });
        scalerSelect.addEventListener("change", () => {
          Layers.setLayerResampling(layer, scalerSelect.value || null);
        });
        scalerRow.appendChild(scalerLabel);
        scalerRow.appendChild(scalerSelect);
        card.appendChild(scalerRow);

        const scale = parseRescale(layer.vizOptions.rescale);
        if (scale) {
          const ramp = document.createElement("div");
          ramp.className = "layer-color-ramp";
          const min = document.createElement("span");
          min.className = "layer-ramp-value";
          min.textContent = formatRampValue(scale.min);
          const bar = document.createElement("div");
          bar.className = `layer-ramp-bar ${rampClass(layer.vizOptions.colormap_name)}`;
          const max = document.createElement("span");
          max.className = "layer-ramp-value";
          max.textContent = formatRampValue(scale.max);
          ramp.appendChild(min);
          ramp.appendChild(bar);
          ramp.appendChild(max);
          card.appendChild(ramp);
        }
      }

      if (layer.loading) {
        const loading = document.createElement("div");
        loading.className = "layer-meta";
        loading.textContent = "Loading…";
        card.appendChild(loading);
      } else if (layer.error) {
        const err = document.createElement("div");
        err.className = "layer-error";
        err.textContent = layer.error;
        card.appendChild(err);
      } else if (layer.sourceDesc) {
        const src = document.createElement("div");
        src.className = "layer-meta";
        src.style.textTransform = "none";
        src.style.letterSpacing = "0";
        src.textContent = layer.sourceDesc;
        card.appendChild(src);
      }

      root.appendChild(card);
    });
  }

  function onLayerDragStart(e) {
    if (e.target.closest("input, select, button, label")) {
      e.preventDefault();
      return;
    }
    const card = e.currentTarget;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.layerId);
  }

  function onLayerDragOver(e) {
    e.preventDefault();
    const card = e.currentTarget;
    if (!card.classList.contains("dragging")) {
      card.classList.add("drag-over");
    }
  }

  function onLayerDragLeave(e) {
    e.currentTarget.classList.remove("drag-over");
  }

  function onLayerDrop(e) {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    const targetId = e.currentTarget.dataset.layerId;
    document.querySelectorAll(".layer-card.drag-over").forEach((el) => {
      el.classList.remove("drag-over");
    });
    if (!draggedId || !targetId || draggedId === targetId) return;
    const topOrderedIds = State.getLayers().slice().reverse().map((layer) => layer.id);
    const from = topOrderedIds.indexOf(draggedId);
    const to = topOrderedIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = topOrderedIds.splice(from, 1);
    topOrderedIds.splice(to, 0, moved);
    Layers.reorderLayersFromTopIds(topOrderedIds);
  }

  function onLayerDragEnd() {
    document.querySelectorAll(".layer-card.dragging, .layer-card.drag-over").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
  }

  function mkIconBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  function parseRescale(rescale) {
    if (!rescale) return null;
    const values = String(rescale).split(",").map(Number);
    if (values.length < 2 || values.some(Number.isNaN)) return null;
    return { min: values[0], max: values[1] };
  }

  function formatRampValue(value) {
    if (!Number.isFinite(value)) return "";
    if (Math.abs(value) >= 10) return value.toFixed(2);
    return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function rampClass(colormapName) {
    const safeName = (colormapName || "grayscale").toLowerCase();
    return "ramp-" + safeName.replace(/[^a-z0-9-]/g, "-");
  }

  // ---- Add layer modal ----

  function initAddModal() {
    const modal = document.getElementById("add-modal");
    const open = document.getElementById("add-layer-btn");
    const closes = modal.querySelectorAll("[data-close-modal]");

    open.addEventListener("click", () => {
      resetModal();
      loadBuiltins();
      modal.classList.remove("hidden");
    });
    closes.forEach((c) =>
      c.addEventListener("click", () => modal.classList.add("hidden"))
    );
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });

    // Tabs
    const tabs = modal.querySelectorAll(".tab");
    const panes = modal.querySelectorAll(".tab-pane");
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        tabs.forEach((x) => {
          x.classList.remove("active");
          x.setAttribute("aria-selected", "false");
        });
        t.classList.add("active");
        t.setAttribute("aria-selected", "true");
        const which = t.dataset.tab;
        panes.forEach((p) => {
          p.classList.toggle("hidden", p.dataset.pane !== which);
        });
        setAddConfirmLabel(which);
      });
    });

    document.getElementById("add-confirm").addEventListener("click", () =>
      onConfirmAdd(modal)
    );
  }

  function resetModal() {
    const modal = document.getElementById("add-modal");
    modal.querySelectorAll(".tab").forEach((tab) => {
      const isDefault = tab.dataset.tab === "titiler";
      tab.classList.toggle("active", isDefault);
      tab.setAttribute("aria-selected", String(isDefault));
    });
    modal.querySelectorAll(".tab-pane").forEach((pane) => {
      pane.classList.toggle("hidden", pane.dataset.pane !== "titiler");
    });
    document.getElementById("titiler-name").value = "";
    document.getElementById("titiler-url").value = "";
    document.getElementById("titiler-colormap").value = "";
    document.getElementById("titiler-min").value = "";
    document.getElementById("titiler-max").value = "";
    document.getElementById("titiler-scaler").value = "";
    document.getElementById("file-name").value = "";
    document.getElementById("file-input").value = "";
    setAddConfirmLabel("titiler");
  }

  function setAddConfirmLabel(activeTab) {
    document.getElementById("add-confirm").textContent =
      activeTab === "builtin" ? "Done" : "Add layer";
  }

  async function onConfirmAdd(modal) {
    const activeTab = modal.querySelector(".tab.active")?.dataset.tab || "titiler";

    try {
      if (activeTab === "titiler") {
        const cogUrl = document.getElementById("titiler-url").value.trim();
        if (!cogUrl) throw new Error("URL is required");
        const name =
          document.getElementById("titiler-name").value.trim() ||
          guessName(cogUrl);
        const style = buildTiTilerStyleFromForm();
        await addUrlLayerWithTiTilerFallback(name, cogUrl, style);
        State.toast(`Added: ${name}`, "success");
      } else if (activeTab === "file") {
        const fileInput = document.getElementById("file-input");
        const file = fileInput.files[0];
        if (!file) throw new Error("Choose a file first");
        const type = Layers.detectType(file.name, "auto");
        if (!type) throw new Error("Unsupported file type");
        const name =
          document.getElementById("file-name").value.trim() || file.name;
        await Layers.addLayerFromConfig({
          name,
          type,
          source: { kind: "file", file },
        });
        State.toast(`Added: ${name}`, "success");
      }
      modal.classList.add("hidden");
    } catch (err) {
      console.error(err);
      State.toast(err.message || String(err), "error");
    }
  }

  function buildTiTilerStyleFromForm() {
    const colormap = document.getElementById("titiler-colormap").value || null;
    const minRaw = document.getElementById("titiler-min").value;
    const maxRaw = document.getElementById("titiler-max").value;
    const scaler = document.getElementById("titiler-scaler").value || null;
    if (!colormap && minRaw === "" && maxRaw === "" && !scaler) return null;
    return {
      colormap_name: colormap || null,
      min: minRaw === "" ? null : Number(minRaw),
      max: maxRaw === "" ? null : Number(maxRaw),
      resampling: scaler,
    };
  }

  async function addUrlLayerWithTiTilerFallback(name, url, style) {
    try {
      await addTiTilerLayer(name, url, style);
    } catch (err) {
      const type = Layers.detectType(url, "auto");
      if (!type) throw err;
      await Layers.addLayerFromConfig({
        name,
        type,
        source: { kind: "url", url },
      });
    }
  }

  async function addTiTilerLayer(name, cogUrl, style) {
    // Fetch bounds and info from TiTiler in parallel
    const [boundsData, infoData] = await Promise.all([
      fetch(`${window.D2S.getTiTilerBase()}/cog/bounds?url=${encodeURIComponent(cogUrl)}`).then(r => {
        if (!r.ok) throw new Error(`TiTiler bounds request failed: ${r.status}`);
        return r.json();
      }),
      fetch(`${window.D2S.getTiTilerBase()}/cog/info?url=${encodeURIComponent(cogUrl)}`).then(r => {
        if (!r.ok) throw new Error(`TiTiler info request failed: ${r.status}`);
        return r.json();
      }),
    ]);

    const bounds = boundsData.bounds; // [minx, miny, maxx, maxy] in EPSG:4326

    // Build visualization options
    const vizOptions = {};
    const bandCount = infoData.count || 1;

    if (bandCount === 1) {
      vizOptions.bidx = "1";
      if (style && style.colormap_name) {
        vizOptions.colormap_name = style.colormap_name;
      }
      if (style && style.resampling) {
        vizOptions.resampling = style.resampling;
      }
      // Auto-rescale from band statistics if no explicit min/max
      const stats = infoData.band_metadata && infoData.band_metadata[0] && infoData.band_metadata[0][1];
      if (style && style.min != null && style.max != null) {
        vizOptions.rescale = `${style.min},${style.max}`;
      } else if (stats && stats.STATISTICS_MINIMUM != null && stats.STATISTICS_MAXIMUM != null) {
        vizOptions.rescale = `${stats.STATISTICS_MINIMUM},${stats.STATISTICS_MAXIMUM}`;
      }
    } else if (bandCount >= 3) {
      vizOptions.bidx = "1,2,3";
      if (style && style.resampling) {
        vizOptions.resampling = style.resampling;
      }
    }

    const tileUrl = window.D2S.buildTiTilerTileUrl(cogUrl, vizOptions);

    await Layers.addD2STileLayer({
      name,
      tileUrl,
      bounds,
      type: "raster",
      sourceDesc: "TiTiler: " + cogUrl.split("/").pop(),
      cogUrl,
      vizOptions,
    });
  }

  function guessName(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || u.hostname;
    } catch {
      return url.slice(0, 40);
    }
  }

  async function loadBuiltins() {
    const root = document.getElementById("builtin-list");
    if (!root) return;
    root.innerHTML = "";

    if (window.BoundaryLayers) {
      await window.BoundaryLayers.render(root);
    }

    let catalog;
    try {
      const res = await fetch("layers.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
    } catch (err) {
      console.warn("No layers.json catalog:", err);
      const hint = document.createElement("li");
      hint.className = "empty-hint";
      hint.textContent = window.BoundaryLayers
        ? "No additional built-in layers configured."
        : "No built-in layers configured.";
      root.appendChild(hint);
      return;
    }
    (catalog.layers || []).forEach((cfg) => {
      const li = document.createElement("li");
      li.className = "builtin-item";

      const meta = document.createElement("div");
      meta.className = "meta";
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = cfg.name;
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent =
        cfg.description ||
        (cfg.times ? `${cfg.times.length} timesteps` : cfg.type || "");
      meta.appendChild(nm);
      meta.appendChild(desc);
      li.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "btn-ghost";
      btn.textContent = "Add";
      btn.addEventListener("click", () => addBuiltin(cfg, btn));
      li.appendChild(btn);

      root.appendChild(li);
    });
  }

  async function addBuiltin(cfg, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Adding…";
    }
    try {
      const normalized = {
        name: cfg.name,
        type: cfg.type,
        style: cfg.style || null,
      };
      if (cfg.times) {
        normalized.times = cfg.times;
      } else if (cfg.url) {
        normalized.source = { kind: "builtin", url: cfg.url };
      } else {
        throw new Error("Built-in layer needs either 'url' or 'times'");
      }
      await Layers.addLayerFromConfig(normalized);
      document.getElementById("add-modal").classList.add("hidden");
      State.toast(`Added: ${cfg.name}`, "success");
    } catch (err) {
      State.toast(`Failed to add ${cfg.name}: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add";
      }
    }
  }

  // ---- Sidebar collapse ----

  function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const collapseBtn = document.getElementById("toggle-sidebar");
    const openBtn = document.getElementById("open-sidebar");
    collapseBtn.addEventListener("click", () => {
      sidebar.classList.add("collapsed");
      openBtn.classList.remove("hidden");
      setTimeout(() => State.getMap().resize(), 220);
    });
    openBtn.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
      openBtn.classList.add("hidden");
      setTimeout(() => State.getMap().resize(), 220);
    });
  }

  // ---- Toast ----

  let toastTimer = null;
  function initToast() {
    State.on("toast", ({ message, kind }) => {
      const t = document.getElementById("toast");
      t.textContent = message;
      t.className = `toast ${kind || ""}`;
      t.classList.remove("hidden");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
    });
  }

  // ---- Bootstrap ----

  function boot() {
    initMap();
    renderBasemapSelect();
    initAddModal();
    initSidebarToggle();
    initToast();

    State.on("layers:changed", renderLayerList);
    State.on("layer:updated", renderLayerList);
    renderLayerList();

    if (window.TimeSlider) window.TimeSlider.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
