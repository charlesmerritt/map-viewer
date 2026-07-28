/* ----------------------------------------------------------------
   boundary-layers.js — built-in US state/county polygon toggles.

   Loads simplified static GeoJSON assets from public/data and exposes a
   small renderer for the Built-in tab in app.js.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;

  const INDEX_URL = "data/us-admin-index.json";
  const STATES_URL = "data/us-states.geojson";
  const COUNTIES_URL = "data/us-counties.geojson";

  const IDS = {
    statesSource: "admin-boundaries-states-source",
    countiesSource: "admin-boundaries-counties-source",
    statesFill: "admin-boundaries-states-fill",
    statesLine: "admin-boundaries-states-line",
    countiesFill: "admin-boundaries-counties-fill",
    countiesLine: "admin-boundaries-counties-line",
    selectionSource: "admin-boundaries-selection-source",
    selectionFill: "admin-boundaries-selection-fill",
    selectionLine: "admin-boundaries-selection-line",
  };

  let indexPromise = null;
  let index = null;
  let statesDataPromise = null;
  let countiesDataPromise = null;
  let selectedStateFp = null;
  let selectedBoundary = null;
  let stateClickHandlerAttached = false;
  let countyClickHandlerAttached = false;

  const selectedStateFips = new Set();
  const selectedCountyGeoids = new Set();

  async function render(root) {
    const panel = document.createElement("li");
    panel.className = "admin-boundary-panel";
    root.appendChild(panel);

    try {
      index = await loadIndex();
      if (!selectedStateFp && index.states.length > 0) {
        selectedStateFp = index.states[0].statefp;
      }
      renderPanel(panel);
    } catch (err) {
      console.error("Failed to load administrative boundary index", err);
      panel.innerHTML = "";
      const title = document.createElement("div");
      title.className = "admin-boundary-title";
      title.textContent = "Administrative boundaries";
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = "State/county boundaries are not available.";
      panel.appendChild(title);
      panel.appendChild(hint);
    }
  }

  function renderPanel(panel) {
    panel.innerHTML = "";
    const state = selectedState();
    const counties = state ? state.counties : [];

    const title = document.createElement("div");
    title.className = "admin-boundary-title";
    title.textContent = "Administrative boundaries";
    panel.appendChild(title);

    const hint = document.createElement("p");
    hint.className = "hint admin-boundary-hint";
    hint.textContent = "Toggle built-in US Census polygons without adding a URL.";
    panel.appendChild(hint);

    const bulk = document.createElement("div");
    bulk.className = "admin-bulk-toggles";
    const allStates = addCheckbox(bulk, {
      id: "admin-all-states",
      label: "All states",
      checked: selectedStateFips.size === index.stateCount,
      onChange: (checked) => {
        selectedStateFips.clear();
        if (checked) index.states.forEach((item) => selectedStateFips.add(item.statefp));
      },
      panel,
    });
    allStates.indeterminate = selectedStateFips.size > 0 && selectedStateFips.size < index.stateCount;

    const allCounties = addCheckbox(bulk, {
      id: "admin-all-counties",
      label: "All counties",
      checked: selectedCountyGeoids.size === index.countyCount,
      onChange: (checked) => {
        selectedCountyGeoids.clear();
        if (checked) {
          index.states.forEach((item) => {
            item.counties.forEach((county) => selectedCountyGeoids.add(county.geoid));
          });
        }
      },
      panel,
    });
    allCounties.indeterminate = selectedCountyGeoids.size > 0 && selectedCountyGeoids.size < index.countyCount;
    panel.appendChild(bulk);

    const stateField = document.createElement("label");
    stateField.className = "field admin-state-field";
    const stateLabel = document.createElement("span");
    stateLabel.textContent = "State / territory";
    const stateSelect = document.createElement("select");
    stateSelect.id = "admin-state-select";
    index.states.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.statefp;
      option.textContent = `${item.name} (${item.stusps})`;
      option.selected = item.statefp === selectedStateFp;
      stateSelect.appendChild(option);
    });
    stateSelect.addEventListener("change", () => {
      selectedStateFp = stateSelect.value;
      renderPanel(panel);
    });
    stateField.appendChild(stateLabel);
    stateField.appendChild(stateSelect);
    panel.appendChild(stateField);

    if (!state) return;

    const stateActions = document.createElement("div");
    stateActions.className = "admin-state-actions";
    addCheckbox(stateActions, {
      id: "admin-selected-state",
      label: `Show ${state.name} polygon`,
      checked: selectedStateFips.has(state.statefp),
      onChange: (checked) => toggleSet(selectedStateFips, state.statefp, checked),
      panel,
    });

    const stateCountyToggle = addCheckbox(stateActions, {
      id: "admin-selected-state-counties",
      label: `All counties in ${state.name}`,
      checked: counties.length > 0 && counties.every((county) => selectedCountyGeoids.has(county.geoid)),
      disabled: counties.length === 0,
      onChange: (checked) => {
        counties.forEach((county) => toggleSet(selectedCountyGeoids, county.geoid, checked));
      },
      panel,
    });
    stateCountyToggle.indeterminate =
      counties.some((county) => selectedCountyGeoids.has(county.geoid)) &&
      !counties.every((county) => selectedCountyGeoids.has(county.geoid));
    panel.appendChild(stateActions);

    const countyHead = document.createElement("div");
    countyHead.className = "admin-county-head";
    const countyTitle = document.createElement("span");
    countyTitle.textContent = `Counties (${counties.length})`;
    countyHead.appendChild(countyTitle);
    panel.appendChild(countyHead);

    if (counties.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-hint";
      empty.textContent = "No county polygons are available for this state/territory.";
      panel.appendChild(empty);
    } else {
      const countyList = document.createElement("ul");
      countyList.className = "admin-county-list";
      counties.forEach((county) => {
        const item = document.createElement("li");
        addCheckbox(item, {
          id: `admin-county-${county.geoid}`,
          label: county.name,
          checked: selectedCountyGeoids.has(county.geoid),
          onChange: (checked) => toggleSet(selectedCountyGeoids, county.geoid, checked),
          panel,
        });
        countyList.appendChild(item);
      });
      panel.appendChild(countyList);
    }

    const status = document.createElement("div");
    status.className = "admin-boundary-status";
    status.textContent = `${selectedStateFips.size} state polygon${selectedStateFips.size === 1 ? "" : "s"} and ${selectedCountyGeoids.size} county polygon${selectedCountyGeoids.size === 1 ? "" : "s"} visible.`;
    panel.appendChild(status);
  }

  function addCheckbox(parent, options) {
    const label = document.createElement("label");
    label.className = "admin-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = options.id;
    input.checked = !!options.checked;
    input.disabled = !!options.disabled;
    input.addEventListener("change", () => {
      options.onChange(input.checked);
      applyBoundarySelections().catch((err) => {
        console.error("Failed to update administrative boundaries", err);
        State.toast(err.message || String(err), "error");
      });
      renderPanel(options.panel);
    });
    const text = document.createElement("span");
    text.textContent = options.label;
    label.appendChild(input);
    label.appendChild(text);
    parent.appendChild(label);
    return input;
  }

  function toggleSet(set, value, checked) {
    if (checked) {
      set.add(value);
      return;
    }
    set.delete(value);
  }

  function selectedState() {
    return index.states.find((state) => state.statefp === selectedStateFp) || index.states[0] || null;
  }

  async function loadIndex() {
    if (!indexPromise) indexPromise = fetchJson(INDEX_URL);
    return indexPromise;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
    return response.json();
  }

  async function whenMapReady() {
    const map = State.getMap();
    if (!map) throw new Error("Map not ready");
    const styleLoaded =
      typeof map.isStyleLoaded === "function" ? map.isStyleLoaded() : map.loaded();
    if (styleLoaded) return map;
    return new Promise((resolve) => map.once("load", () => resolve(map)));
  }

  async function loadStatesData() {
    if (!statesDataPromise) statesDataPromise = fetchJson(STATES_URL);
    return statesDataPromise;
  }

  async function loadCountiesData() {
    if (!countiesDataPromise) countiesDataPromise = fetchJson(COUNTIES_URL);
    return countiesDataPromise;
  }

  async function applyBoundarySelections() {
    const map = await whenMapReady();

    if (selectedStateFips.size > 0) {
      await ensureStateLayers(map);
    }
    if (selectedCountyGeoids.size > 0) {
      await ensureCountyLayers(map);
    }

    updateLayerVisibilityAndFilters(map, {
      fillId: IDS.statesFill,
      lineId: IDS.statesLine,
      property: "statefp",
      selectedValues: selectedStateFips,
      totalCount: index.stateCount,
    });
    updateLayerVisibilityAndFilters(map, {
      fillId: IDS.countiesFill,
      lineId: IDS.countiesLine,
      property: "geoid",
      selectedValues: selectedCountyGeoids,
      totalCount: index.countyCount,
    });
    orderBoundaryLayers(map);
  }

  async function ensureStateLayers(map) {
    if (!map.getSource(IDS.statesSource)) {
      map.addSource(IDS.statesSource, {
        type: "geojson",
        data: await loadStatesData(),
        promoteId: "statefp",
      });
    }
    if (!map.getLayer(IDS.statesFill)) {
      map.addLayer({
        id: IDS.statesFill,
        type: "fill",
        source: IDS.statesSource,
        layout: { visibility: "none" },
        paint: {
          "fill-color": "#22c55e",
          "fill-opacity": 0.12,
        },
      });
    }
    if (!map.getLayer(IDS.statesLine)) {
      map.addLayer({
        id: IDS.statesLine,
        type: "line",
        source: IDS.statesSource,
        layout: { visibility: "none" },
        paint: {
          "line-color": "#a7f3d0",
          "line-width": 1.6,
          "line-opacity": 0.95,
        },
      });
    }
    attachStateClickHandler(map);
  }

  async function ensureCountyLayers(map) {
    if (!map.getSource(IDS.countiesSource)) {
      map.addSource(IDS.countiesSource, {
        type: "geojson",
        data: await loadCountiesData(),
        promoteId: "geoid",
      });
    }
    if (!map.getLayer(IDS.countiesFill)) {
      map.addLayer({
        id: IDS.countiesFill,
        type: "fill",
        source: IDS.countiesSource,
        layout: { visibility: "none" },
        paint: {
          "fill-color": "#f59e0b",
          "fill-opacity": 0.10,
        },
      });
    }
    if (!map.getLayer(IDS.countiesLine)) {
      map.addLayer({
        id: IDS.countiesLine,
        type: "line",
        source: IDS.countiesSource,
        layout: { visibility: "none" },
        paint: {
          "line-color": "#fbbf24",
          "line-width": 0.8,
          "line-opacity": 0.85,
        },
      });
    }
    attachCountyClickHandler(map);
  }

  function updateLayerVisibilityAndFilters(map, config) {
    if (!map.getLayer(config.fillId) || !map.getLayer(config.lineId)) return;

    const visibility = config.selectedValues.size > 0 ? "visible" : "none";
    map.setLayoutProperty(config.fillId, "visibility", visibility);
    map.setLayoutProperty(config.lineId, "visibility", visibility);

    if (config.selectedValues.size === 0) return;

    const filter = selectedValuesFilter(
      config.property,
      config.selectedValues,
      config.totalCount
    );
    map.setFilter(config.fillId, filter);
    map.setFilter(config.lineId, filter);
  }

  function selectedValuesFilter(property, selectedValues, totalCount) {
    if (selectedValues.size >= totalCount) return null;
    return ["in", ["get", property], ["literal", Array.from(selectedValues)]];
  }

  function orderBoundaryLayers(map) {
    [
      IDS.countiesFill,
      IDS.countiesLine,
      IDS.statesFill,
      IDS.statesLine,
      IDS.selectionFill,
      IDS.selectionLine,
    ].forEach((id) => {
      if (map.getLayer(id)) map.moveLayer(id);
    });

    if (map.getLayer("basemap")) {
      const firstNonBase = map.getStyle().layers.find((layer) => layer.id !== "basemap");
      if (firstNonBase) map.moveLayer("basemap", firstNonBase.id);
    }
  }

  function attachStateClickHandler(map) {
    if (stateClickHandlerAttached) return;
    map.on("click", IDS.statesFill, async (event) => {
      if (window.DrawTools?.isActive?.()) return;
      if (window.DrawTools?.isPointOnDrawnPolygon?.(event.point)) return;
      if (map.getLayer(IDS.countiesFill)) {
        const countyFeatures = map.queryRenderedFeatures(event.point, {
          layers: [IDS.countiesFill],
        });
        if (countyFeatures.length > 0) return;
      }
      const feature = event.features && event.features[0];
      if (!feature) return;
      const statefp = String(feature.properties?.statefp || feature.properties?.STATEFP || "");
      const data = await loadStatesData();
      const fullFeature = data.features.find((item) => item.properties.statefp === statefp);
      if (fullFeature) selectBoundary("state", fullFeature);
    });
    map.on("mouseenter", IDS.statesFill, () => {
      if (!window.DrawTools?.isActive?.()) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", IDS.statesFill, () => {
      if (!window.DrawTools?.isActive?.()) map.getCanvas().style.cursor = "";
    });
    stateClickHandlerAttached = true;
  }

  function attachCountyClickHandler(map) {
    if (countyClickHandlerAttached) return;
    map.on("click", IDS.countiesFill, async (event) => {
      if (window.DrawTools?.isActive?.()) return;
      if (window.DrawTools?.isPointOnDrawnPolygon?.(event.point)) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      const geoid = String(feature.properties?.geoid || feature.properties?.GEOID || "");
      const data = await loadCountiesData();
      const fullFeature = data.features.find((item) => item.properties.geoid === geoid);
      if (fullFeature) selectBoundary("county", fullFeature);
    });
    map.on("mouseenter", IDS.countiesFill, () => {
      if (!window.DrawTools?.isActive?.()) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", IDS.countiesFill, () => {
      if (!window.DrawTools?.isActive?.()) map.getCanvas().style.cursor = "";
    });
    countyClickHandlerAttached = true;
  }

  function selectBoundary(kind, feature) {
    const map = State.getMap();
    const properties = feature.properties || {};
    selectedBoundary = {
      kind,
      id: kind === "county" ? properties.geoid : properties.statefp,
      name: properties.name,
      statefp: properties.statefp,
      stusps: properties.stusps,
      geoid: properties.geoid || null,
      geometry: feature.geometry,
      bbox: bboxOfGeometry(feature.geometry),
    };
    if (map) showSelectedBoundary(map, feature);
    State.emit("boundary:selected", selectedBoundary);
    State.toast(`Selected ${selectedBoundary.name}`, "success");
  }

  function showSelectedBoundary(map, feature) {
    if (!map.getSource(IDS.selectionSource)) {
      map.addSource(IDS.selectionSource, {
        type: "geojson",
        data: feature,
      });
    } else {
      map.getSource(IDS.selectionSource).setData(feature);
    }

    if (!map.getLayer(IDS.selectionFill)) {
      map.addLayer({
        id: IDS.selectionFill,
        type: "fill",
        source: IDS.selectionSource,
        paint: {
          "fill-color": "#38bdf8",
          "fill-opacity": 0.18,
        },
      });
    }
    if (!map.getLayer(IDS.selectionLine)) {
      map.addLayer({
        id: IDS.selectionLine,
        type: "line",
        source: IDS.selectionSource,
        paint: {
          "line-color": "#e0f2fe",
          "line-width": 3,
          "line-opacity": 1,
        },
      });
    }
    orderBoundaryLayers(map);
  }

  function bboxOfGeometry(geometry) {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    walkCoordinates(geometry.coordinates, (point) => {
      bbox[0] = Math.min(bbox[0], point[0]);
      bbox[1] = Math.min(bbox[1], point[1]);
      bbox[2] = Math.max(bbox[2], point[0]);
      bbox[3] = Math.max(bbox[3], point[1]);
    });
    return bbox.every(Number.isFinite) ? bbox : null;
  }

  function walkCoordinates(coordinates, visit) {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number") {
      visit(coordinates);
      return;
    }
    coordinates.forEach((child) => walkCoordinates(child, visit));
  }

  window.BoundaryLayers = {
    render,
    getSelectedBoundary: () => selectedBoundary,
  };
})();
