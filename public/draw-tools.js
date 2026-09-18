/* ----------------------------------------------------------------
   draw-tools.js — draw polygons, circles, and rectangles on the map.

   Minimal, dependency-free drawing on a MapLibre GeoJSON source:
     - Polygon: click to add vertices, double-click or Enter to
       finish, Esc to cancel.
     - Circle: click (or click-and-drag) to set the center, then drag
       to size the radius, or type a number (miles) and press Enter.
       Esc cancels. The circle is a true geodesic circle (accurate in
       miles at any latitude), not a degree-based ellipse.
     - Rectangle: click-and-drag to size it; hold Shift to constrain
       it to a square. Esc cancels.

   Finished shapes become selectable zones — they emit the same
   "boundary:selected" event the zonal tools already listen for, with
   kind "drawn".

   Public surface (window.DrawTools):
     init()
     isActive()      — true while any shape is being drawn
     startDrawing()  — starts the polygon tool
     clearAll()
     raiseLayers()  — re-stack the drawn layers above the rasters
     isPointOnDrawnPolygon(point) — a drawn shape is under this screen point
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;
  const Geometry = window.DrawGeometry;

  const IDS = {
    drawnSource: "drawn-polygons-source",
    drawnFill: "drawn-polygons-fill",
    drawnLine: "drawn-polygons-line",
    drawnSelectedLine: "drawn-polygons-selected-line",
    activeSource: "draw-active-source",
    activeFill: "draw-active-fill",
    activeLine: "draw-active-line",
    activeVertices: "draw-active-vertices",
    activeSnap: "draw-active-snap",
    activeLabel: "draw-active-label",
  };

  // How close (in screen pixels) the cursor must be to the first vertex to
  // snap: the closing double-click drops the stray vertex, and while
  // hovering the preview line closes onto it and it lights up.
  const SNAP_CLOSE_PIXELS = 12;

  // Below this many screen pixels a mousedown→mouseup is a "click" (place
  // then wait) rather than a "drag" (place and size in one motion).
  const DRAG_CLICK_PIXELS = 6;

  let activeTool = null; // null | "polygon" | "circle" | "rectangle"

  // Polygon state
  let vertices = [];
  let cursorPoint = null;
  let snapping = false;

  // Circle state
  let circleCenter = null;
  let dragRadiusMiles = 0;
  let circleTypedBuffer = "";

  // Rectangle state
  let rectStart = null;
  let rectEnd = null;
  let rectShiftHeld = false;

  // Shared mousedown/mouseup tracking for circle & rectangle
  let pointerDownAt = null;
  let settingAnchorClick = false;

  const counters = { polygon: 0, circle: 0, rectangle: 0 };
  const drawnFeatures = [];
  let selectedDrawnId = null;
  const toolbarButtons = {};

  function init() {
    const map = State.getMap();
    if (!map) return;

    map.addControl({ onAdd: buildControl, onRemove: () => {} }, "top-right");

    document.getElementById("zonal-draw-btn")?.addEventListener("click", () => toggleTool("polygon"));
    document.getElementById("zonal-draw-circle-btn")?.addEventListener("click", () => toggleTool("circle"));
    document.getElementById("zonal-draw-rect-btn")?.addEventListener("click", () => toggleTool("rectangle"));
    document.getElementById("zonal-clear-drawn-btn")?.addEventListener("click", clearAll);

    map.on("click", onMapClick);
    map.on("mousemove", onMapMouseMove);
    map.on("mousedown", onMapMouseDown);
    map.on("mouseup", onMapMouseUp);
    map.on("dblclick", onMapDblClick);
    document.addEventListener("keydown", onKeyDown);
  }

  function buildControl(map) {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group draw-ctrl";

    toolbarButtons.polygon = addToolButton(
      container,
      "&#11040;", // ⬠
      "Draw polygon (double-click or Enter to finish, Esc to cancel)",
      "Draw polygon",
      () => toggleTool("polygon")
    );
    toolbarButtons.circle = addToolButton(
      container,
      "&#9711;", // ◯
      "Draw circle (drag to size, or type a radius in miles and press Enter, Esc to cancel)",
      "Draw circle",
      () => toggleTool("circle")
    );
    toolbarButtons.rectangle = addToolButton(
      container,
      "&#9645;", // ▭
      "Draw rectangle (drag to size, hold Shift for a square, Esc to cancel)",
      "Draw rectangle",
      () => toggleTool("rectangle")
    );

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "draw-ctrl-btn";
    clearButton.title = "Remove all drawn shapes";
    clearButton.setAttribute("aria-label", "Remove all drawn shapes");
    clearButton.innerHTML = "&#10005;"; // ✕
    clearButton.addEventListener("click", clearAll);
    container.appendChild(clearButton);

    return container;
  }

  function addToolButton(container, html, title, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "draw-ctrl-btn";
    button.title = title;
    button.setAttribute("aria-label", label);
    button.innerHTML = html;
    button.addEventListener("click", onClick);
    container.appendChild(button);
    return button;
  }

  function isActive() {
    return activeTool !== null;
  }

  function toggleTool(tool) {
    if (activeTool === tool) cancelDrawing();
    else beginTool(tool);
  }

  function startDrawing() {
    beginTool("polygon");
  }

  function beginTool(tool) {
    const map = State.getMap();
    if (!map) return;
    ensureLayers(map);
    activeTool = tool;
    resetToolState();
    map.getCanvas().style.cursor = "crosshair";
    updateToolbarActive();

    if (tool === "polygon") {
      map.doubleClickZoom.disable();
      State.toast("Click to add vertices; double-click or Enter to finish, Esc to cancel.", "info");
    } else if (tool === "circle") {
      map.dragPan.disable();
      State.toast(
        "Click and drag to draw a circle, or click then type a radius in miles and press Enter. Esc to cancel.",
        "info"
      );
    } else if (tool === "rectangle") {
      map.dragPan.disable();
      map.boxZoom.disable();
      State.toast("Click and drag to draw a rectangle. Hold Shift for a square. Esc to cancel.", "info");
    }
    updateActiveSource(map);
  }

  function resetToolState() {
    vertices = [];
    cursorPoint = null;
    snapping = false;
    circleCenter = null;
    dragRadiusMiles = 0;
    circleTypedBuffer = "";
    rectStart = null;
    rectEnd = null;
    rectShiftHeld = false;
    pointerDownAt = null;
    settingAnchorClick = false;
  }

  function cancelDrawing() {
    finishDrawingState();
    State.toast("Drawing cancelled.", "info");
  }

  function finishDrawingState() {
    const map = State.getMap();
    activeTool = null;
    resetToolState();
    updateToolbarActive();
    if (map) {
      map.doubleClickZoom.enable();
      map.dragPan.enable();
      map.boxZoom.enable();
      map.getCanvas().style.cursor = "";
      updateActiveSource(map);
    }
  }

  function updateToolbarActive() {
    Object.entries(toolbarButtons).forEach(([tool, button]) => {
      button?.classList.toggle("active", tool === activeTool);
    });
  }

  // ---- Polygon interaction ----

  function onMapClick(event) {
    if (activeTool !== "polygon") return;
    const point = [event.lngLat.lng, event.lngLat.lat];
    const last = vertices[vertices.length - 1];
    // A double-click delivers a second identical click first — skip it.
    if (last && last[0] === point[0] && last[1] === point[1]) return;
    vertices.push(point);
    updateActiveSource(State.getMap());
  }

  function onMapDblClick(event) {
    if (activeTool !== "polygon") return;
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
    return Math.hypot(first.x - pixel.x, first.y - pixel.y) <= SNAP_CLOSE_PIXELS;
  }

  function finishPolygon() {
    if (vertices.length < 3) {
      State.toast("A polygon needs at least 3 vertices.", "error");
      return;
    }
    const ring = vertices.slice();
    ring.push([ring[0][0], ring[0][1]]);
    addDrawnShape("polygon", ring);
  }

  // ---- Circle & rectangle interaction ----

  function onMapMouseDown(event) {
    if (activeTool === "circle") {
      const point = [event.lngLat.lng, event.lngLat.lat];
      pointerDownAt = event.point;
      if (!circleCenter) {
        circleCenter = point;
        dragRadiusMiles = 0;
        circleTypedBuffer = "";
        settingAnchorClick = true;
      } else {
        settingAnchorClick = false;
      }
      updateActiveSource(State.getMap());
    } else if (activeTool === "rectangle") {
      const point = [event.lngLat.lng, event.lngLat.lat];
      pointerDownAt = event.point;
      if (!rectStart) {
        rectStart = point;
        rectEnd = point;
        settingAnchorClick = true;
      } else {
        settingAnchorClick = false;
      }
      updateActiveSource(State.getMap());
    }
  }

  function onMapMouseUp(event) {
    if (activeTool !== "circle" && activeTool !== "rectangle") return;
    const movedFar =
      pointerDownAt && Math.hypot(event.point.x - pointerDownAt.x, event.point.y - pointerDownAt.y) > DRAG_CLICK_PIXELS;
    const wasAnchorClick = settingAnchorClick;
    settingAnchorClick = false;
    // The mouseup that completed the click which just placed the anchor
    // (center / first corner) shouldn't also finish the shape — unless the
    // user actually dragged during that same press, which reads as one
    // continuous "click and drag" gesture.
    if (wasAnchorClick && !movedFar) return;
    if (activeTool === "circle") finalizeCircle();
    else finalizeRectangle();
  }

  function onMapMouseMove(event) {
    if (!activeTool) return;
    const map = State.getMap();
    if (activeTool === "polygon") {
      if (vertices.length === 0) return;
      cursorPoint = [event.lngLat.lng, event.lngLat.lat];
      // Once there are enough vertices to close, hovering near the first one
      // previews the snap so the user can see where the ring will shut.
      snapping = vertices.length >= 3 && nearFirstVertex(event.point);
      map.getCanvas().style.cursor = snapping ? "pointer" : "crosshair";
      updateActiveSource(map);
    } else if (activeTool === "circle") {
      if (!circleCenter) return;
      dragRadiusMiles = Geometry.haversineMiles(circleCenter, [event.lngLat.lng, event.lngLat.lat]);
      updateActiveSource(map);
    } else if (activeTool === "rectangle") {
      if (!rectStart) return;
      rectEnd = [event.lngLat.lng, event.lngLat.lat];
      rectShiftHeld = !!(event.originalEvent && event.originalEvent.shiftKey);
      updateActiveSource(map);
    }
  }

  function effectiveCircleRadius() {
    if (circleTypedBuffer !== "") {
      const typed = parseFloat(circleTypedBuffer);
      return Number.isFinite(typed) ? typed : 0;
    }
    return dragRadiusMiles;
  }

  function finalizeCircle() {
    const radius = effectiveCircleRadius();
    if (!circleCenter || !(radius > 0)) {
      State.toast("Drag or type a radius greater than 0 to finish the circle.", "error");
      return;
    }
    const ring = Geometry.circlePolygonCoords(circleCenter, radius);
    addDrawnShape("circle", ring, { center: circleCenter, radiusMiles: radius });
  }

  function rectRingCoords(start, end, shift, map) {
    return Geometry.rectRingCoords(
      start,
      end,
      shift,
      map && ((p) => map.project(p)),
      map && ((p) => map.unproject(p))
    );
  }

  function finalizeRectangle() {
    const map = State.getMap();
    if (!rectStart || !rectEnd) return;
    const ring = rectRingCoords(rectStart, rectEnd, rectShiftHeld, map);
    if (!Geometry.rectRingHasArea(ring)) {
      State.toast("Drag to size the rectangle before finishing.", "error");
      return;
    }
    addDrawnShape("rectangle", ring);
  }

  function onKeyDown(event) {
    if (!activeTool) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDrawing();
      return;
    }
    if (activeTool === "polygon") {
      if (event.key === "Enter") {
        event.preventDefault();
        finishPolygon();
      }
      return;
    }
    if (activeTool === "circle") {
      if (!circleCenter) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finalizeCircle();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        circleTypedBuffer = circleTypedBuffer.slice(0, -1);
        updateActiveSource(State.getMap());
      } else if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        circleTypedBuffer += event.key;
        updateActiveSource(State.getMap());
      } else if (event.key === "." && !circleTypedBuffer.includes(".")) {
        event.preventDefault();
        circleTypedBuffer += ".";
        updateActiveSource(State.getMap());
      }
      return;
    }
    if (activeTool === "rectangle") {
      if (event.key === "Enter" && rectStart) {
        event.preventDefault();
        finalizeRectangle();
      }
    }
  }

  // ---- Finished shapes ----

  function addDrawnShape(shape, ring, extra) {
    counters[shape] += 1;
    const id = "drawn-" + shape + "-" + counters[shape];
    const name = "Drawn " + shape + " " + counters[shape];
    const feature = {
      type: "Feature",
      properties: Object.assign({ id, name, shape }, extra),
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    drawnFeatures.push(feature);

    finishDrawingState();
    updateDrawnSource(State.getMap());
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
    State.toast("Removed all drawn shapes.", "info");
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
        if (!activeTool) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", IDS.drawnFill, () => {
        if (!activeTool) map.getCanvas().style.cursor = "";
      });
    }
    if (!map.getSource(IDS.activeSource)) {
      map.addSource(IDS.activeSource, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: IDS.activeFill,
        type: "fill",
        source: IDS.activeSource,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#e879f9", "fill-opacity": 0.12 },
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
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "label"]]],
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
      map.addLayer({
        id: IDS.activeLabel,
        type: "symbol",
        source: IDS.activeSource,
        filter: ["has", "label"],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-offset": [0, -1.2],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#f0e7ff",
          "text-halo-color": "#1c2230",
          "text-halo-width": 1.5,
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
      IDS.activeFill,
      IDS.activeLine,
      IDS.activeVertices,
      IDS.activeSnap,
      IDS.activeLabel,
    ].forEach((id) => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
  }

  function onDrawnPolygonClick(event) {
    if (activeTool) return;
    const clicked = event.features && event.features[0];
    if (!clicked) return;
    const feature = drawnFeatures.find((f) => f.properties.id === clicked.properties.id);
    if (feature) selectDrawn(feature);
  }

  // Is a finished drawn shape rendered at this screen point? The built-in
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
    const source = map && map.getSource(IDS.activeSource);
    if (!source) return;
    const features = [];

    if (activeTool === "polygon" && vertices.length > 0) {
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
    } else if (activeTool === "circle" && circleCenter) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: circleCenter } });
      const radius = effectiveCircleRadius();
      if (radius > 0) {
        const ring = Geometry.circlePolygonCoords(circleCenter, radius);
        features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } });
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
        features.push({
          type: "Feature",
          properties: { label: Geometry.formatMilesValue(radius) + " mi" },
          geometry: { type: "Point", coordinates: Geometry.destinationPoint(circleCenter, 90, radius) },
        });
      } else {
        features.push({
          type: "Feature",
          properties: { label: "Drag or type a radius (mi)" },
          geometry: { type: "Point", coordinates: circleCenter },
        });
      }
    } else if (activeTool === "rectangle" && rectStart && rectEnd) {
      const ring = rectRingCoords(rectStart, rectEnd, rectShiftHeld, map);
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } });
      if (Geometry.rectRingHasArea(ring)) {
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
        const [minLng, minLat] = ring[0];
        const [maxLng, maxLat] = ring[2];
        const centerLng = (minLng + maxLng) / 2;
        const centerLat = (minLat + maxLat) / 2;
        const widthMiles = Geometry.haversineMiles([minLng, centerLat], [maxLng, centerLat]);
        const heightMiles = Geometry.haversineMiles([centerLng, minLat], [centerLng, maxLat]);
        features.push({
          type: "Feature",
          properties: { label: Geometry.formatMilesValue(widthMiles) + " × " + Geometry.formatMilesValue(heightMiles) + " mi" },
          geometry: { type: "Point", coordinates: [centerLng, centerLat] },
        });
      }
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
