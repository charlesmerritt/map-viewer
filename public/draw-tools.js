/* ----------------------------------------------------------------
   draw-tools.js — draw arbitrary polygons on the map.

   Minimal, dependency-free vertex-by-vertex drawing on a MapLibre
   GeoJSON source: click to add vertices, double-click or Enter to
   finish, Esc to cancel. Finished polygons become selectable zones —
   they emit the same "boundary:selected" event the zonal tools
   already listen for, with kind "drawn".

   Public surface (window.DrawTools):
     init()
     isActive()      — true while a polygon is being drawn
     startDrawing()
     clearAll()
     raiseLayers()  — re-stack the drawn layers above the rasters
     isPointOnDrawnPolygon(point) — a drawn polygon is under this screen point
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;

  const IDS = {
    drawnSource: "drawn-polygons-source",
    drawnFill: "drawn-polygons-fill",
    drawnLine: "drawn-polygons-line",
    drawnSelectedLine: "drawn-polygons-selected-line",
    activeSource: "draw-active-source",
    activeLine: "draw-active-line",
    activeVertices: "draw-active-vertices",
    activeSnap: "draw-active-snap",
  };

  // How close (in screen pixels) the cursor must be to the first vertex to
  // snap: the closing double-click drops the stray vertex, and while
  // hovering the preview line closes onto it and it lights up.
  // A fingertip is far less precise than a cursor, so the radius grows on
  // coarse pointers, where tapping the first vertex is also how you close.
  const SNAP_CLOSE_PIXELS = 12;
  const SNAP_CLOSE_PIXELS_COARSE = 24;

  function snapRadius() {
    return window.matchMedia("(pointer: coarse)").matches
      ? SNAP_CLOSE_PIXELS_COARSE
      : SNAP_CLOSE_PIXELS;
  }

  let active = false;
  let vertices = [];
  let cursorPoint = null;
  let snapping = false; // cursor is within snap range of the first vertex
  let drawnCounter = 0;
  const drawnFeatures = [];
  let selectedDrawnId = null;
  let toolbarButton = null;
  let actionBar = null;

  function init() {
    const map = State.getMap();
    if (!map) return;

    map.addControl({ onAdd: buildControl, onRemove: () => {} }, "top-right");

    document.getElementById("zonal-draw-btn")?.addEventListener("click", toggleDrawing);
    document.getElementById("zonal-clear-drawn-btn")?.addEventListener("click", clearAll);
    initActionBar();

    map.on("click", onMapClick);
    map.on("mousemove", onMapMouseMove);
    map.on("dblclick", onMapDblClick);
    document.addEventListener("keydown", onKeyDown);
  }

  function buildControl(map) {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group draw-ctrl";

    toolbarButton = document.createElement("button");
    toolbarButton.type = "button";
    toolbarButton.className = "draw-ctrl-btn";
    toolbarButton.title = "Draw polygon (double-click or Enter to finish, Esc to cancel)";
    toolbarButton.setAttribute("aria-label", "Draw polygon");
    toolbarButton.innerHTML = "&#11040;"; // ⬠
    toolbarButton.addEventListener("click", toggleDrawing);
    container.appendChild(toolbarButton);

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "draw-ctrl-btn";
    clearButton.title = "Remove all drawn polygons";
    clearButton.setAttribute("aria-label", "Remove all drawn polygons");
    clearButton.innerHTML = "&#10005;"; // ✕
    clearButton.addEventListener("click", clearAll);
    container.appendChild(clearButton);

    return container;
  }

  // Double-click and Enter are the only ways this ever offered to finish a
  // polygon, and a phone has neither. The action bar is the touch path: it
  // appears while drawing, counts vertices, and can undo, finish or cancel.
  function initActionBar() {
    actionBar = document.getElementById("draw-actions");
    if (!actionBar) return;
    document.getElementById("draw-finish")?.addEventListener("click", finishPolygon);
    document.getElementById("draw-cancel")?.addEventListener("click", cancelDrawing);
    document.getElementById("draw-undo")?.addEventListener("click", undoVertex);
    syncActionBar();
  }

  function syncActionBar() {
    const drawButton = document.getElementById("zonal-draw-btn");
    drawButton?.setAttribute("aria-pressed", String(active));
    toolbarButton?.setAttribute("aria-pressed", String(active));

    if (!actionBar) return;
    actionBar.classList.toggle("hidden", !active);

    const count = vertices.length;
    const label = document.getElementById("draw-vertex-count");
    if (label) {
      label.textContent =
        count === 0
          ? "Tap the map to start"
          : `${count} point${count === 1 ? "" : "s"}` +
            (count >= 3 ? " — tap the first point to close" : "");
    }
    const finish = document.getElementById("draw-finish");
    if (finish) finish.disabled = count < 3;
    const undo = document.getElementById("draw-undo");
    if (undo) undo.disabled = count === 0;
  }

  function undoVertex() {
    if (!active || vertices.length === 0) return;
    vertices.pop();
    updateActiveSource(State.getMap());
  }

  function isActive() {
    return active;
  }

  function toggleDrawing() {
    if (active) cancelDrawing();
    else startDrawing();
  }

  function startDrawing() {
    const map = State.getMap();
    if (!map || active) return;
    ensureLayers(map);
    active = true;
    vertices = [];
    cursorPoint = null;
    snapping = false;
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = "crosshair";
    // On the sheet layout an expanded panel would cover the map and the draw
    // controls, so drawing drops it to peek. Nothing is hidden, just moved.
    if (window.SheetUI?.isSheetLayout?.()) window.SheetUI.setSnap("peek");
    toolbarButton?.classList.add("active");
    State.toast(
      "Tap the map to add points, then Finish polygon. The first point closes it.",
      "info"
    );
    updateActiveSource(map);
  }

  function cancelDrawing() {
    finishDrawingState();
    State.toast("Drawing cancelled.", "info");
  }

  function finishDrawingState() {
    const map = State.getMap();
    active = false;
    vertices = [];
    cursorPoint = null;
    snapping = false;
    toolbarButton?.classList.remove("active");
    if (map) {
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = "";
      updateActiveSource(map);
    }
    syncActionBar();
  }

  function onMapClick(event) {
    if (!active) return;
    // Tapping the first vertex closes the ring. This is the standard idiom and,
    // on touch, the only precise closing gesture available.
    if (vertices.length >= 3 && nearFirstVertex(event.point)) {
      finishPolygon();
      return;
    }
    const point = [event.lngLat.lng, event.lngLat.lat];
    const last = vertices[vertices.length - 1];
    // A double-click delivers a second identical click first — skip it.
    if (last && last[0] === point[0] && last[1] === point[1]) return;
    vertices.push(point);
    updateActiveSource(State.getMap());
  }

  function onMapMouseMove(event) {
    if (!active || vertices.length === 0) return;
    cursorPoint = [event.lngLat.lng, event.lngLat.lat];
    // Once there are enough vertices to close, hovering near the first one
    // previews the snap so the user can see where the ring will shut.
    snapping = vertices.length >= 3 && nearFirstVertex(event.point);
    const map = State.getMap();
    map.getCanvas().style.cursor = snapping ? "pointer" : "crosshair";
    updateActiveSource(map);
  }

  function onMapDblClick(event) {
    if (!active) return;
    event.preventDefault();
    // The double-click's first click already added a vertex here. If that
    // landed near the first vertex, drop it so the polygon snaps closed on
    // the start point instead of leaving a stray vertex beside it.
    if (vertices.length >= 4 && nearFirstVertex(event.point)) {
      vertices.pop();
    }
    finishPolygon();
  }

  function nearFirstVertex(pixel) {
    const map = State.getMap();
    if (!map || vertices.length === 0) return false;
    const first = map.project(vertices[0]);
    return Math.hypot(first.x - pixel.x, first.y - pixel.y) <= snapRadius();
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDrawing();
    } else if (event.key === "Enter") {
      event.preventDefault();
      finishPolygon();
    }
  }

  function finishPolygon() {
    if (vertices.length < 3) {
      State.toast("A polygon needs at least 3 vertices.", "error");
      return;
    }
    const ring = vertices.slice();
    ring.push([ring[0][0], ring[0][1]]);

    drawnCounter += 1;
    const id = "drawn-" + drawnCounter;
    const name = "Drawn polygon " + drawnCounter;
    const feature = {
      type: "Feature",
      properties: { id, name },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    drawnFeatures.push(feature);

    finishDrawingState();
    const map = State.getMap();
    updateDrawnSource(map);
    selectDrawn(feature);
  }

  function selectDrawn(feature) {
    const map = State.getMap();
    selectedDrawnId = feature.properties.id;
    if (map && map.getLayer(IDS.drawnSelectedLine)) {
      map.setFilter(IDS.drawnSelectedLine, ["==", ["get", "id"], selectedDrawnId]);
    }
    State.emit("boundary:selected", {
      kind: "drawn",
      id: feature.properties.id,
      name: feature.properties.name,
      geometry: feature.geometry,
      bbox: bboxOfRing(feature.geometry.coordinates[0]),
    });
    State.toast(`Selected ${feature.properties.name}`, "success");
  }

  function clearAll() {
    if (drawnFeatures.length === 0) return;
    drawnFeatures.length = 0;
    const hadSelection = selectedDrawnId != null;
    selectedDrawnId = null;
    const map = State.getMap();
    updateDrawnSource(map);
    if (map && map.getLayer(IDS.drawnSelectedLine)) {
      map.setFilter(IDS.drawnSelectedLine, ["==", ["get", "id"], ""]);
    }
    if (hadSelection) State.emit("boundary:cleared");
    State.toast("Removed all drawn polygons.", "info");
  }

  // ---- Map sources & layers ----

  function ensureLayers(map) {
    if (!map.getSource(IDS.drawnSource)) {
      map.addSource(IDS.drawnSource, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: IDS.drawnFill,
        type: "fill",
        source: IDS.drawnSource,
        paint: { "fill-color": "#c084fc", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: IDS.drawnLine,
        type: "line",
        source: IDS.drawnSource,
        paint: { "line-color": "#c084fc", "line-width": 2 },
      });
      map.addLayer({
        id: IDS.drawnSelectedLine,
        type: "line",
        source: IDS.drawnSource,
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": "#f0e7ff", "line-width": 3.5 },
      });
      map.on("click", IDS.drawnFill, onDrawnPolygonClick);
      map.on("mouseenter", IDS.drawnFill, () => {
        if (!active) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", IDS.drawnFill, () => {
        if (!active) map.getCanvas().style.cursor = "";
      });
    }
    if (!map.getSource(IDS.activeSource)) {
      map.addSource(IDS.activeSource, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: IDS.activeLine,
        type: "line",
        source: IDS.activeSource,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#e879f9",
          "line-width": 2,
          "line-dasharray": [2, 1.5],
        },
      });
      map.addLayer({
        id: IDS.activeVertices,
        type: "circle",
        source: IDS.activeSource,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#e879f9",
          "circle-stroke-color": "#1c2230",
          "circle-stroke-width": 1.5,
        },
      });
      // Ring around the first vertex when the cursor is snapped to it,
      // signalling "double-click here to close".
      map.addLayer({
        id: IDS.activeSnap,
        type: "circle",
        source: IDS.activeSource,
        filter: ["==", ["get", "snap"], true],
        paint: {
          "circle-radius": 8,
          "circle-color": "rgba(240,231,255,0.2)",
          "circle-stroke-color": "#f0e7ff",
          "circle-stroke-width": 2,
        },
      });
    }
  }

  // The draw layers are added on top once, but adding or reordering a
  // raster afterwards moves it above them — and an opaque raster hides
  // a 0.15-opacity fill completely. layers.js calls this whenever it
  // restacks, mirroring how it keeps the basemap pinned at the bottom.
  function raiseLayers() {
    const map = State.getMap();
    if (!map) return;
    [
      IDS.drawnFill,
      IDS.drawnLine,
      IDS.drawnSelectedLine,
      IDS.activeLine,
      IDS.activeVertices,
      IDS.activeSnap,
    ].forEach((id) => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
  }

  function onDrawnPolygonClick(event) {
    if (active) return;
    const clicked = event.features && event.features[0];
    if (!clicked) return;
    const feature = drawnFeatures.find((f) => f.properties.id === clicked.properties.id);
    if (feature) selectDrawn(feature);
  }

  // Is a finished drawn polygon rendered at this screen point? The built-in
  // state/county click handlers call this to defer to a drawn zone sitting on
  // top of them — otherwise both their handler and onDrawnPolygonClick fire for
  // the same click and the selection flips to whichever runs last. Mirrors how
  // the state handler already defers to counties under the cursor.
  function isPointOnDrawnPolygon(point) {
    const map = State.getMap();
    if (!map || !map.getLayer(IDS.drawnFill)) return false;
    return map.queryRenderedFeatures(point, { layers: [IDS.drawnFill] }).length > 0;
  }

  function updateDrawnSource(map) {
    const source = map && map.getSource(IDS.drawnSource);
    if (source) source.setData({ type: "FeatureCollection", features: drawnFeatures });
  }

  function updateActiveSource(map) {
    // Every vertex add / undo / cancel routes through here, so this is the one
    // place the action bar needs to re-read the vertex count from.
    syncActionBar();
    const source = map && map.getSource(IDS.activeSource);
    if (!source) return;
    const features = [];
    if (active && vertices.length > 0) {
      const line = vertices.slice();
      // When snapping, run the trailing segment back to the first vertex so
      // the ring visibly closes; otherwise it follows the cursor.
      if (cursorPoint) line.push(snapping ? vertices[0] : cursorPoint);
      if (line.length >= 2) {
        features.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: line },
        });
      }
      vertices.forEach((point, index) => {
        features.push({
          type: "Feature",
          properties: { snap: snapping && index === 0 },
          geometry: { type: "Point", coordinates: point },
        });
      });
    }
    source.setData({ type: "FeatureCollection", features });
  }

  function bboxOfRing(ring) {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    ring.forEach((point) => {
      bbox[0] = Math.min(bbox[0], point[0]);
      bbox[1] = Math.min(bbox[1], point[1]);
      bbox[2] = Math.max(bbox[2], point[0]);
      bbox[3] = Math.max(bbox[3], point[1]);
    });
    return bbox.every(Number.isFinite) ? bbox : null;
  }

  window.DrawTools = { init, isActive, startDrawing, clearAll, raiseLayers, isPointOnDrawnPolygon };
})();
