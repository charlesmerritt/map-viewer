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
  const GroupCore = window.LayerGroupsCore;

  let lastSelectedLayerId = null;
  let suppressNextLayerClick = false;

  // ---- Base layers ----

  const cartoApiKey = (window.__ENV && window.__ENV.CARTO_API_KEY) || "";

  const BASE_LAYERS = [
    {
      name: "Carto Dark",
      url: `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${cartoApiKey}`,
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
      url: `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${cartoApiKey}`,
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

    const renderedGroupIds = new Set();
    layers.forEach((layer) => {
      const group = State.getGroupForLayer(layer.id);
      if (!group) {
        root.appendChild(renderLayerCard(layer));
        return;
      }
      if (renderedGroupIds.has(group.id)) return;
      renderedGroupIds.add(group.id);
      const groupLayers = layers.filter((candidate) => group.layerIds.includes(candidate.id));
      root.appendChild(renderLayerGroup(group, groupLayers));
    });

    renderLayerToolbar();
  }

  function renderLayerGroup(group, groupLayers) {
    const item = document.createElement("li");
    item.className = "layer-group";
    item.dataset.groupId = group.id;
    if (State.getActiveTimeGroup()?.id === group.id) item.classList.add("active-time-group");

    const header = document.createElement("div");
    header.className = "layer-group-header";
    header.addEventListener("click", (e) => {
      if (isLayerInteractiveTarget(e.target)) return;
      if (group.timeWidget) State.setActiveTimeGroup(group.id);
    });

    const collapse = mkIconBtn(group.collapsed ? "▸" : "▾", "Collapse group", () => {
      State.updateLayerGroup(group.id, { collapsed: !group.collapsed });
    });
    collapse.classList.add("layer-group-collapse");
    header.appendChild(collapse);

    const titleWrap = document.createElement("div");
    titleWrap.className = "layer-group-title-wrap";

    const title = document.createElement("div");
    title.className = "layer-group-title";
    title.textContent = group.name;
    title.title = group.name;
    titleWrap.appendChild(title);

    const renameBtn = mkIconBtn("✎", "Rename group", () => renameLayerGroup(group));
    renameBtn.classList.add("layer-group-rename");
    titleWrap.appendChild(renameBtn);
    header.appendChild(titleWrap);

    const count = document.createElement("div");
    count.className = "layer-group-count";
    count.textContent = `${groupLayers.length} layers`;
    header.appendChild(count);

    item.appendChild(header);

    const actions = document.createElement("div");
    actions.className = "layer-group-actions";

    const selectBtn = mkSmallBtn("Select", "Select group layers", () => {
      State.setSelectedLayerIds(group.layerIds);
      lastSelectedLayerId = group.layerIds[0] || null;
    });
    actions.appendChild(selectBtn);

    const sliderBtn = mkSmallBtn(group.timeWidget ? "Slider on" : "Slider", "Toggle group time slider", () => {
      const updated = State.updateLayerGroup(group.id, { timeWidget: !group.timeWidget });
      if (updated?.timeWidget) {
        State.setActiveTimeGroup(updated.id);
        Layers.setGroupTimeIndex(updated, updated.timeIndex || 0);
      } else {
        State.reconcileActiveTimeLayer();
      }
    });
    sliderBtn.classList.toggle("active", !!group.timeWidget);
    actions.appendChild(sliderBtn);

    if (group.timeWidget) {
      const order = document.createElement("select");
      order.className = "group-order-mode";
      order.title = "Group playback order";
      [
        ["top-to-bottom", "Top → bottom"],
        ["bottom-to-top", "Bottom → top"],
        ["custom", "Custom"],
      ].forEach(([value, label]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        order.appendChild(opt);
      });
      order.value = group.orderMode || "top-to-bottom";
      order.addEventListener("change", () => {
        const updated = State.updateLayerGroup(group.id, {
          orderMode: order.value,
          timeIndex: 0,
        });
        State.setActiveTimeGroup(group.id);
        if (updated?.timeWidget) Layers.setGroupTimeIndex(updated, 0);
      });
      actions.appendChild(order);
    }

    const ungroupBtn = mkSmallBtn("Ungroup", "Ungroup these layers", () => {
      State.removeLayerGroup(group.id);
      State.toast(`Ungrouped ${group.name}`, "success");
    });
    actions.appendChild(ungroupBtn);
    item.appendChild(actions);

    const children = document.createElement("ul");
    children.className = "group-layer-list";
    children.classList.toggle("hidden", !!group.collapsed);
    groupLayers.forEach((layer) => children.appendChild(renderLayerCard(layer, { group })));
    item.appendChild(children);

    return item;
  }

  function renderLayerCard(layer, options = {}) {
    const group = options.group || null;
    const selected = State.getSelectedLayerIds().includes(layer.id);
    const card = document.createElement("li");
    card.className = "layer-card";
    card.classList.toggle("selected", selected);
    card.classList.toggle("layer-card-grouped", !!group);
    card.dataset.layerId = layer.id;
    card.setAttribute("aria-selected", String(selected));
    card.addEventListener("click", onLayerCardClick);
    card.addEventListener("dragover", onLayerDragOver);
    card.addEventListener("dragleave", onLayerDragLeave);
    card.addEventListener("drop", onLayerDrop);

    const row = document.createElement("div");
    row.className = "layer-row";

    const dragHandle = document.createElement("span");
    dragHandle.className = "layer-drag-handle";
    dragHandle.draggable = true;
    dragHandle.textContent = "⋮⋮";
    dragHandle.title = "Drag to reorder layer";
    dragHandle.addEventListener("dragstart", onLayerDragStart);
    dragHandle.addEventListener("dragend", onLayerDragEnd);
    row.appendChild(dragHandle);

    const toggle = document.createElement("label");
    toggle.className = "layer-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!layer.visible;
    // The label wraps the box but has no text, so the control needs its own
    // name or a screen reader announces a bare "checkbox".
    cb.setAttribute("aria-label", `Show ${layer.name} on the map`);
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

    if (group && group.timeWidget && group.orderMode === "custom") {
      row.appendChild(renderLayerOrderSelect(group, layer));
    }

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

    if (layer.type === "d2s-raster" && layer.cogUrl && layer.vizOptions) {
      const styleContainer = group ? card : document.createElement("details");
      if (!group) {
        styleContainer.className = "layer-style-details";
        const summary = document.createElement("summary");
        summary.textContent = "Style options";
        styleContainer.appendChild(summary);
      }

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
      styleContainer.appendChild(cmRow);

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
      styleContainer.appendChild(scalerRow);

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
        styleContainer.appendChild(ramp);
      }
      if (!group) card.appendChild(styleContainer);
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

    return card;
  }

  function renderLayerOrderSelect(group, layer) {
    const select = document.createElement("select");
    select.className = "layer-order-select";
    select.title = "Custom playback order (keys 1–0 also work)";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "#";
    select.appendChild(blank);
    for (let i = 1; i <= 10; i += 1) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `#${i}`;
      select.appendChild(opt);
    }
    select.value = group.customOrder?.[layer.id] ? String(group.customOrder[layer.id]) : "";
    select.addEventListener("change", () => {
      setSingleLayerCustomOrder(group, layer.id, select.value);
    });
    return select;
  }

  function setSingleLayerCustomOrder(group, layerId, rawValue) {
    const customOrder = { ...(group.customOrder || {}) };
    const order = rawValue === "" ? null : Number(rawValue);
    delete customOrder[layerId];
    if (order !== null) {
      Object.keys(customOrder).forEach((id) => {
        if (customOrder[id] === order) delete customOrder[id];
      });
      customOrder[layerId] = order;
    }
    const updated = State.updateLayerGroup(group.id, { customOrder, orderMode: "custom" });
    if (updated?.timeWidget) {
      State.setActiveTimeGroup(updated.id);
      Layers.setGroupTimeIndex(updated, updated.timeIndex || 0);
    }
  }

  function renameLayerGroup(group) {
    const name = window.prompt("Group name", group.name);
    if (name === null) return;
    State.updateLayerGroup(group.id, { name });
  }

  function renderLayerToolbar() {
    const selected = State.getSelectedLayerIds();
    const count = document.getElementById("layer-selection-count");
    const groupBtn = document.getElementById("group-layer-btn");
    const clearBtn = document.getElementById("clear-layer-selection-btn");
    if (!count || !groupBtn || !clearBtn) return;
    count.textContent = `${selected.length} selected`;
    groupBtn.textContent = selectionCanUngroup(selected) ? "Ungroup" : "Group";
    groupBtn.disabled = selected.length < 2;
    clearBtn.disabled = selected.length === 0;
  }

  function selectionCanUngroup(selectedIds) {
    if (selectedIds.length < 2) return false;
    const groups = selectedIds.map((id) => State.getGroupForLayer(id)).filter(Boolean);
    if (groups.length !== selectedIds.length) return false;
    return groups.every((group) => group.id === groups[0].id);
  }

  function initLayerToolbar() {
    document.getElementById("group-layer-btn")?.addEventListener("click", toggleGroupForSelected);
    document.getElementById("select-all-layers-btn")?.addEventListener("click", () => {
      State.setSelectedLayerIds(getVisibleLayerIds());
    });
    document.getElementById("clear-layer-selection-btn")?.addEventListener("click", () => {
      State.clearSelectedLayers();
      lastSelectedLayerId = null;
    });
    initKeyboardHelp();
    document.getElementById("layer-list")?.addEventListener("pointerdown", onLayerListPointerDown);
    document.addEventListener("keydown", onLayerKeyboardShortcut);
  }

  function initKeyboardHelp() {
    const help = document.getElementById("keyboard-help");
    const button = document.getElementById("keyboard-help-btn");
    const panel = help?.querySelector(".keyboard-help-panel");
    if (!help || !button || !panel) return;

    const positionPanel = () => positionKeyboardHelpPanel(button, panel);
    ["mouseenter", "focus"].forEach((eventName) => {
      button.addEventListener(eventName, positionPanel);
    });
    help.addEventListener("mouseenter", positionPanel);
    window.addEventListener("resize", positionPanel);

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      positionPanel();
      const open = !help.classList.contains("open");
      help.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
    });

    document.addEventListener("click", (e) => {
      if (help.contains(e.target)) return;
      help.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      help.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    });
  }

  function positionKeyboardHelpPanel(button, panel) {
    const buttonRect = button.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 270;
    const panelHeight = panel.offsetHeight || 180;
    const gap = 8;

    // Prefer the right of the button; flip to its left when the panel would
    // run off a narrow viewport rather than being clipped there.
    let left = buttonRect.right + gap;
    if (left + panelWidth + gap > window.innerWidth) {
      left = buttonRect.left - panelWidth - gap;
    }
    left = Math.max(gap, Math.min(left, window.innerWidth - panelWidth - gap));

    // The panel is centred on the button vertically, so clamp against half its
    // height at both ends; otherwise it hangs off the top of a short viewport.
    const half = panelHeight / 2;
    const top = Math.max(
      gap + half,
      Math.min(
        buttonRect.top + buttonRect.height / 2,
        window.innerHeight - gap - half
      )
    );

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function toggleGroupForSelected() {
    const selected = State.getSelectedLayerIds();
    if (selected.length < 2) {
      State.toast("Select at least two layers to group", "error");
      return;
    }

    const selectedGroups = selected.map((id) => State.getGroupForLayer(id)).filter(Boolean);
    if (selectedGroups.length === selected.length && selectedGroups.every((group) => group.id === selectedGroups[0].id)) {
      const group = selectedGroups[0];
      if (selected.length === group.layerIds.length) {
        State.removeLayerGroup(group.id);
        State.toast(`Ungrouped ${group.name}`, "success");
        return;
      }
      State.ungroupLayerIds(selected);
      State.toast("Removed selected layers from group", "success");
      return;
    }

    const name = window.prompt("Group name", `Group ${State.getLayerGroups().length + 1}`);
    if (name === null) return;
    const group = State.createLayerGroup({ name, layerIds: selected, timeWidget: true });
    if (!group) {
      State.toast("Could not group selected layers", "error");
      return;
    }
    State.setActiveTimeGroup(group.id);
    Layers.setGroupTimeIndex(group, group.timeIndex || 0);
    State.toast(`Grouped ${group.layerIds.length} layers`, "success");
  }

  function onLayerCardClick(e) {
    if (suppressNextLayerClick) {
      e.preventDefault();
      return;
    }
    if (isLayerInteractiveTarget(e.target)) return;
    const card = e.currentTarget;
    const layerId = card.dataset.layerId;
    if (!layerId) return;

    if (e.shiftKey && lastSelectedLayerId) {
      selectLayerRange(lastSelectedLayerId, layerId);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      State.toggleLayerSelected(layerId);
      lastSelectedLayerId = layerId;
      return;
    }
    State.setSelectedLayerIds([layerId]);
    lastSelectedLayerId = layerId;
  }

  function onLayerListPointerDown(e) {
    if (e.button !== 0 || isLayerInteractiveTarget(e.target)) return;
    const startCard = e.target.closest(".layer-card");
    if (!startCard) return;
    const start = {
      x: e.clientX,
      y: e.clientY,
      layerId: startCard.dataset.layerId,
      selecting: false,
    };

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      if (!start.selecting && Math.hypot(dx, dy) < 6) return;
      start.selecting = true;
      const hoverCard = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".layer-card");
      if (!hoverCard || !document.getElementById("layer-list").contains(hoverCard)) return;
      selectLayerRange(start.layerId, hoverCard.dataset.layerId);
      moveEvent.preventDefault();
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!start.selecting) return;
      suppressNextLayerClick = true;
      window.setTimeout(() => {
        suppressNextLayerClick = false;
      }, 0);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  function selectLayerRange(anchorId, targetId) {
    const ids = getVisibleLayerIds();
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [start, end] = from < to ? [from, to] : [to, from];
    State.setSelectedLayerIds(ids.slice(start, end + 1));
    lastSelectedLayerId = anchorId;
  }

  function getVisibleLayerIds() {
    return Array.from(document.querySelectorAll("#layer-list .layer-card[data-layer-id]"))
      .filter((card) => card.offsetParent !== null)
      .map((card) => card.dataset.layerId);
  }

  function onLayerKeyboardShortcut(e) {
    if (isTextEntryTarget(e.target)) return;
    if (e.key.toLowerCase() === "g") {
      e.preventDefault();
      toggleGroupForSelected();
      return;
    }
    const order = GroupCore.numberKeyToOrder(e.key);
    if (order !== null) {
      assignSelectedCustomOrder(order);
    }
  }

  function assignSelectedCustomOrder(firstOrder) {
    const selected = State.getSelectedLayerIds();
    if (selected.length === 0) return;
    const group = getSelectedWidgetGroup(selected);
    if (!group) return;
    const orderedSelected = getVisibleLayerIds().filter(
      (id) => selected.includes(id) && group.layerIds.includes(id)
    );
    if (firstOrder + orderedSelected.length - 1 > 10) {
      State.toast("Selected layers exceed custom order 10", "error");
      return;
    }
    const updated = State.assignLayerGroupOrder(group.id, orderedSelected, firstOrder);
    if (!updated) return;
    State.setActiveTimeGroup(group.id);
    Layers.setGroupTimeIndex(updated, updated.timeIndex || 0);
    State.toast(`Assigned order starting at ${firstOrder}`, "success");
  }

  function getSelectedWidgetGroup(selectedIds) {
    const groups = selectedIds.map((id) => State.getGroupForLayer(id)).filter(Boolean);
    if (groups.length !== selectedIds.length) return null;
    const group = groups[0];
    if (!group || !group.timeWidget) return null;
    return groups.every((item) => item.id === group.id) ? group : null;
  }

  function isLayerInteractiveTarget(target) {
    return !!target.closest("input, select, button, label, a, summary, details, .layer-drag-handle");
  }

  function isTextEntryTarget(target) {
    const tag = target?.tagName?.toLowerCase();
    return tag === "input" || tag === "select" || tag === "textarea" || target?.isContentEditable;
  }

  function onLayerDragStart(e) {
    const card = e.currentTarget.closest(".layer-card");
    if (!card) {
      e.preventDefault();
      return;
    }
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

  function mkSmallBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "btn-ghost layer-tool-btn";
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
        if (type === "cog") {
          await addUploadedCog(name, file);
        } else {
          await Layers.addLayerFromConfig({
            name,
            type,
            source: { kind: "file", file },
          });
        }
        State.toast(`Added: ${name}`, "success");
      }
      modal.classList.add("hidden");
    } catch (err) {
      console.error(err);
      State.toast(err.message || String(err), "error");
    }
  }

  async function addUploadedCog(name, file) {
    const confirmButton = document.getElementById("add-confirm");
    let upload = null;
    confirmButton.disabled = true;
    confirmButton.textContent = "Uploading COG…";

    try {
      upload = await window.RasterUploads.upload(file);
      confirmButton.textContent = "Checking COG…";
      await addTiTilerLayer(name, upload.url, null, {
        sourceDesc: `Uploaded COG: ${file.name}`,
        uploadDeleteUrl: upload.deleteUrl,
      });
    } catch (error) {
      if (upload) {
        await window.RasterUploads.remove(upload.deleteUrl).catch(() => {});
        throw new Error(
          "The tiler could not open this upload. Confirm it is a georeferenced " +
            `Cloud-Optimized GeoTIFF. ${error.message || error}`
        );
      }
      throw error;
    } finally {
      confirmButton.disabled = false;
      setAddConfirmLabel("file");
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

  async function addTiTilerLayer(name, cogUrl, style, options = {}) {
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

    const layer = await Layers.addD2STileLayer({
      name,
      tileUrl,
      bounds,
      type: "raster",
      sourceDesc: options.sourceDesc || "TiTiler: " + cogUrl.split("/").pop(),
      cogUrl,
      vizOptions,
      uploadDeleteUrl: options.uploadDeleteUrl || null,
    });
    if (layer.error) {
      Layers.removeLayer(layer);
      throw new Error(layer.error);
    }
    return layer;
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

  // ---- Sidebar collapse / resize ----

  const SIDEBAR_WIDTH_KEY = "perseus.sidebarWidth";
  const SIDEBAR_MIN_WIDTH = 320;
  const SIDEBAR_MAX_WIDTH = 620;

  // Below this width the panel is a bottom sheet over the map rather than a
  // column beside it. Kept in sync with the same breakpoint in styles.css.
  const PHONE_QUERY = "(max-width: 767.98px)";
  const phoneMedia = window.matchMedia(PHONE_QUERY);

  function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const collapseBtn = document.getElementById("toggle-sidebar");
    const openBtn = document.getElementById("open-sidebar");

    collapseBtn.addEventListener("click", () => {
      // On a phone the panel never leaves the screen; it drops to its peek
      // snap, which keeps it reachable without a second floating control.
      if (phoneMedia.matches) {
        Sheet.setSnap(Sheet.currentSnap() === "peek" ? "half" : "peek");
        return;
      }
      sidebar.classList.add("collapsed");
      collapseBtn.setAttribute("aria-expanded", "false");
      openBtn.classList.remove("hidden");
      openBtn.focus();
      setTimeout(() => State.getMap()?.resize(), 220);
    });

    openBtn.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
      collapseBtn.setAttribute("aria-expanded", "true");
      openBtn.classList.add("hidden");
      collapseBtn.focus();
      setTimeout(() => State.getMap()?.resize(), 220);
    });
  }

  // ---- Bottom sheet (phone layout) ----

  // The sheet moves by writing --sheet-y, an offset in px from the fully-open
  // position. Transform only, so dragging never triggers layout.
  const Sheet = (() => {
    const SNAP_ORDER = ["peek", "half", "full"];
    let snap = "half";
    let drag = null;
    let sidebar = null;
    // A pointerup at the end of a drag is still followed by a click, which
    // would then cycle the snap a second time and undo the drag.
    let suppressClick = false;

    const peekPx = () =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--sheet-peek")
      ) || 60;

    const travel = () => Math.max(0, sidebar.offsetHeight - peekPx());

    function offsetFor(name) {
      if (name === "full") return 0;
      if (name === "peek") return travel();
      return Math.min(travel(), Math.round(sidebar.offsetHeight * 0.5));
    }

    function currentOffset() {
      const raw = sidebar.style.getPropertyValue("--sheet-y");
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : offsetFor(snap);
    }

    function setSnap(name, { animate = true } = {}) {
      if (!sidebar || !SNAP_ORDER.includes(name)) return;
      snap = name;
      sidebar.dataset.snap = name;
      if (!animate) sidebar.classList.add("sheet-dragging");
      const offset = offsetFor(name);
      sidebar.style.setProperty("--sheet-y", `${offset}px`);
      // Scrollable slack matching the hidden overhang. Set here rather than in
      // the drag loop: padding is layout, --sheet-y alone is not.
      sidebar.style.setProperty("--sheet-pad", `${offset}px`);
      if (!animate) {
        requestAnimationFrame(() => sidebar.classList.remove("sheet-dragging"));
      }
      const collapseBtn = document.getElementById("toggle-sidebar");
      collapseBtn?.setAttribute("aria-expanded", String(name !== "peek"));
      collapseBtn?.setAttribute(
        "aria-label",
        name === "peek" ? "Expand layer panel" : "Collapse layer panel"
      );
    }

    function nearestSnap(offset) {
      return SNAP_ORDER.reduce((best, name) =>
        Math.abs(offsetFor(name) - offset) < Math.abs(offsetFor(best) - offset)
          ? name
          : best
      );
    }

    function step(direction) {
      const index = SNAP_ORDER.indexOf(snap);
      const next = Math.min(SNAP_ORDER.length - 1, Math.max(0, index + direction));
      setSnap(SNAP_ORDER[next]);
    }

    function beginDrag(event) {
      if (!phoneMedia.matches) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      drag = {
        id: event.pointerId,
        startY: event.clientY,
        startOffset: currentOffset(),
        moved: false,
      };
      sidebar.classList.add("sheet-dragging");
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    function moveDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault();
      if (Math.abs(event.clientY - drag.startY) > 4) drag.moved = true;
      const next = Math.min(
        travel(),
        Math.max(0, drag.startOffset + (event.clientY - drag.startY))
      );
      sidebar.style.setProperty("--sheet-y", `${next}px`);
    }

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const settled = nearestSnap(currentOffset());
      suppressClick = drag.moved;
      drag = null;
      sidebar.classList.remove("sheet-dragging");
      setSnap(settled);
    }

    function attachDrag(element, { ignoreControls = false } = {}) {
      if (!element) return;
      element.addEventListener("pointerdown", (event) => {
        if (ignoreControls && event.target.closest("button, a, input, select, label")) {
          return;
        }
        beginDrag(event);
      });
      element.addEventListener("pointermove", moveDrag);
      element.addEventListener("pointerup", endDrag);
      element.addEventListener("pointercancel", endDrag);
    }

    function init() {
      sidebar = document.getElementById("sidebar");
      if (!sidebar) return;
      const handle = document.getElementById("sheet-handle");

      attachDrag(handle);
      attachDrag(document.querySelector(".sidebar-header"), { ignoreControls: true });

      // Keyboard equivalent for the drag gesture.
      handle?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          step(1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          step(-1);
        }
      });
      handle?.addEventListener("click", () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        setSnap(snap === "full" ? "peek" : snap === "peek" ? "half" : "full");
      });

      // The map's usable area changes with the sheet, so it has to re-measure.
      sidebar.addEventListener("transitionend", (event) => {
        if (event.propertyName === "transform") State.getMap()?.resize();
      });

      const sync = () => {
        if (phoneMedia.matches) setSnap(snap, { animate: false });
        else {
          sidebar.style.removeProperty("--sheet-y");
          sidebar.style.removeProperty("--sheet-pad");
        }
        State.getMap()?.resize();
      };
      phoneMedia.addEventListener("change", sync);
      window.addEventListener("orientationchange", () => setTimeout(sync, 120));
      window.addEventListener("resize", debounce(sync, 150));
      sync();
    }

    return { init, setSnap, currentSnap: () => snap, isSheetLayout: () => phoneMedia.matches };
  })();

  window.SheetUI = Sheet;

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function initSidebarResizer() {
    const sidebar = document.getElementById("sidebar");
    const resizer = document.getElementById("sidebar-resizer");
    if (!sidebar || !resizer) return;

    const savedWidth = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!phoneMedia.matches && savedWidth > 0) setSidebarWidth(savedWidth);

    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (phoneMedia.matches) return;
      sidebar.classList.add("resizing");
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    resizer.addEventListener("pointermove", (e) => {
      if (!sidebar.classList.contains("resizing")) return;
      setSidebarWidth(e.clientX);
      State.getMap()?.resize();
    });

    resizer.addEventListener("pointerup", (e) => {
      if (!sidebar.classList.contains("resizing")) return;
      sidebar.classList.remove("resizing");
      resizer.releasePointerCapture(e.pointerId);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentSidebarWidth()));
      State.getMap()?.resize();
    });

    resizer.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 24 : -24;
      setSidebarWidth(currentSidebarWidth() + delta);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentSidebarWidth()));
      State.getMap()?.resize();
    });
  }

  function setSidebarWidth(width) {
    const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
    document.documentElement.style.setProperty("--sidebar-w", `${Math.round(next)}px`);
  }

  function currentSidebarWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w");
    return Number.parseFloat(raw) || SIDEBAR_MIN_WIDTH;
  }

  // ---- Bottom-anchored map chrome ----

  // The time bar wraps to two or three rows on a phone, so anything stacked
  // above it needs its real height, not a guess.
  function initTimeBarMetrics() {
    const bar = document.getElementById("time-bar");
    if (!bar) return;
    const write = () => {
      const visible = !bar.classList.contains("hidden");
      document.documentElement.style.setProperty(
        "--time-bar-h",
        visible ? `${Math.round(bar.offsetHeight) + 12}px` : "0px"
      );
    };
    new ResizeObserver(write).observe(bar);
    new MutationObserver(write).observe(bar, {
      attributes: true,
      attributeFilter: ["class"],
    });
    write();
  }

  // ---- Modal keyboard + focus behaviour ----

  // Both modals are plain divs toggled with .hidden, so neither closed on Escape
  // nor kept focus inside itself. This wires that centrally: closing routes
  // through each modal's own close button so their existing teardown still runs.
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function initModalA11y() {
    const modals = Array.from(document.querySelectorAll(".modal"));
    if (!modals.length) return;
    let lastFocused = null;

    const openModal = () =>
      modals.filter((m) => !m.classList.contains("hidden")).pop() || null;

    const closeButton = (modal) =>
      modal.querySelector("[data-close-modal], [data-close-zonal-modal]");

    // Watch the class attribute rather than patching every open/close call site.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const modal = record.target;
        const hidden = modal.classList.contains("hidden");
        if (!hidden && modal.dataset.open !== "true") {
          modal.dataset.open = "true";
          lastFocused = document.activeElement;
          const first = modal.querySelector(FOCUSABLE);
          // Defer so the modal's own render finishes before focus moves.
          requestAnimationFrame(() => first?.focus());
        } else if (hidden && modal.dataset.open === "true") {
          delete modal.dataset.open;
          if (lastFocused instanceof HTMLElement && lastFocused.isConnected) {
            lastFocused.focus();
          }
          lastFocused = null;
        }
      }
    });
    modals.forEach((modal) =>
      observer.observe(modal, { attributes: true, attributeFilter: ["class"] })
    );

    document.addEventListener("keydown", (event) => {
      const modal = openModal();
      if (!modal) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeButton(modal)?.click();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
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
    initSidebarResizer();
    Sheet.init();
    initModalA11y();
    initTimeBarMetrics();
    initToast();
    initLayerToolbar();
    if (window.DrawTools) window.DrawTools.init();
    if (window.ZonalStats) window.ZonalStats.init();

    State.on("layers:changed", renderLayerList);
    State.on("layer:updated", renderLayerList);
    State.on("groups:changed", renderLayerList);
    State.on("selection:changed", renderLayerList);
    State.on("time:active-changed", renderLayerList);
    renderLayerList();

    if (window.TimeSlider) window.TimeSlider.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
