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
      meta.textContent = layer.type === "cog" ? "RASTER" : "VECTOR";
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

  function mkIconBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- Built-in layers ----

  async function loadBuiltins() {
    const root = document.getElementById("builtin-list");
    root.innerHTML = "";
    let catalog;
    try {
      const res = await fetch("layers.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
    } catch (err) {
      console.warn("No layers.json catalog:", err);
      const hint = document.createElement("li");
      hint.className = "empty-hint";
      hint.textContent = "No built-in layers configured.";
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

  // ---- Add-layer modal ----

  function initAddModal() {
    const modal = document.getElementById("add-modal");
    const open = document.getElementById("add-layer-btn");
    const closes = modal.querySelectorAll("[data-close-modal]");

    open.addEventListener("click", () => {
      resetModal();
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
      });
    });

    document.getElementById("add-confirm").addEventListener("click", () =>
      onConfirmAdd(modal)
    );
  }

  function resetModal() {
    document.getElementById("url-name").value = "";
    document.getElementById("url-input").value = "";
    document.getElementById("url-type").value = "auto";
    document.getElementById("url-colormap").value = "";
    document.getElementById("url-min").value = "";
    document.getElementById("url-max").value = "";
    document.getElementById("file-name").value = "";
    document.getElementById("file-input").value = "";
  }

  async function onConfirmAdd(modal) {
    const activeTab = modal.querySelector(".tab.active")?.dataset.tab || "url";

    try {
      if (activeTab === "url") {
        const url = document.getElementById("url-input").value.trim();
        if (!url) throw new Error("URL is required");
        const explicit = document.getElementById("url-type").value;
        const type = Layers.detectType(url, explicit);
        if (!type) {
          throw new Error(
            "Could not auto-detect type. Pick COG or GeoJSON manually."
          );
        }
        const name =
          document.getElementById("url-name").value.trim() ||
          guessName(url);
        const style = buildStyleFromForm();
        await Layers.addLayerFromConfig({
          name,
          type,
          source: { kind: "url", url },
          style,
        });
        State.toast(`Added: ${name}`, "success");
      } else {
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

  function buildStyleFromForm() {
    const colormap = document.getElementById("url-colormap").value || null;
    const minRaw = document.getElementById("url-min").value;
    const maxRaw = document.getElementById("url-max").value;
    if (!colormap && minRaw === "" && maxRaw === "") return null;
    return {
      colormap: colormap || "viridis",
      min: minRaw === "" ? null : Number(minRaw),
      max: maxRaw === "" ? null : Number(maxRaw),
    };
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

    loadBuiltins();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
