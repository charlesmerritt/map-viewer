/* ----------------------------------------------------------------
   vector-tiles.js — pg_tileserv vector layers.

   Rasters go COG -> TiTiler -> raster tiles. Vectors go PostGIS ->
   pg_tileserv -> MVT, and this module is the client half of that: it
   builds the MapLibre paint specs (including data-driven expressions for
   attribute styling) and the popup HTML.

   Public surface (window.VectorTiles):
     getTileBaseUrl()
     fetchCatalog()
     uploadGeoJson(file, name)
     deleteLayer(tableName)
     fetchBounds(tableName)
     buildPaintLayers(config, entry)
     styleExpression(style, attribute)
   ---------------------------------------------------------------- */

(function (root) {
  "use strict";

  const DEFAULT_COLOR = "#6ab048";

  // Categorical ramp for `match` styling. Chosen to stay distinguishable on
  // the dark basemaps and to survive the common forms of colour-vision
  // deficiency, per the WCAG commitments in PRODUCT.md.
  const CATEGORY_COLORS = [
    "#6ab048", "#4a9fd8", "#e8a33d", "#c2569b",
    "#5ec9b8", "#d96a5a", "#9b8ad6", "#b5c334",
  ];

  function getTileBaseUrl() {
    const configured = (root.__ENV && root.__ENV.VECTOR_TILE_BASE_URL) || "";
    return configured.replace(/\/$/, "");
  }

  function isConfigured() {
    return Boolean(getTileBaseUrl());
  }

  // ---- API ----

  async function fetchCatalog() {
    const res = await fetch("/api/vector/layers", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching vector catalog");
    return await res.json();
  }

  async function uploadGeoJson(file, name) {
    const params = new URLSearchParams({ name: name || file.name });
    const res = await fetch(`/api/vector/layers?${params}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: file,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || `Upload failed (HTTP ${res.status})`);
    }
    return payload;
  }

  async function deleteLayer(tableName) {
    const res = await fetch(`/api/vector/layers/${tableName}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `Delete failed (HTTP ${res.status})`);
    }
  }

  // Re-reads a feature from PostGIS by id. A feature picked out of a vector
  // tile has geometry clipped to that tile, so anything that measures area —
  // zonal statistics above all — must use this rather than the tile geometry.
  async function fetchFeature(tableName, id) {
    const res = await fetch(
      `/api/vector/layers/${tableName}/features/${encodeURIComponent(id)}`
    );
    if (!res.ok) return null;
    return await res.json();
  }

  async function fetchBounds(tableName) {
    const res = await fetch(`/api/vector/layers/${tableName}/bounds`);
    if (!res.ok) return null;
    const payload = await res.json();
    return payload.bounds || null;
  }

  // ---- Styling ----

  function numericRamp(style, attribute) {
    const min = Number(style.min);
    const max = Number(style.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;

    const ramp = style.colormap && root.chroma
      ? root.chroma.scale(style.colormap)
      : null;
    const stops = 6;
    const expression = ["interpolate", ["linear"], ["to-number", ["get", attribute], 0]];
    for (let i = 0; i < stops; i += 1) {
      const t = i / (stops - 1);
      expression.push(min + t * (max - min));
      expression.push(ramp ? ramp(t).hex() : DEFAULT_COLOR);
    }
    return expression;
  }

  function categoricalRamp(style, attribute) {
    const categories = Array.isArray(style.categories) ? style.categories : [];
    if (categories.length === 0) return null;
    const expression = ["match", ["to-string", ["get", attribute]]];
    categories.forEach((category, i) => {
      expression.push(String(category));
      expression.push(CATEGORY_COLORS[i % CATEGORY_COLORS.length]);
    });
    expression.push(style.color || DEFAULT_COLOR); // fallback for unmatched
    return expression;
  }

  // Returns either a colour string or a MapLibre data-driven expression. This
  // is the whole point of the vector-tile path: colour comes from the feature's
  // own attributes rather than being one flat value per layer.
  function styleExpression(style, attribute) {
    const s = style || {};
    const attr = attribute || s.attribute;
    if (!attr) return s.color || DEFAULT_COLOR;
    if (s.mode === "categorical") {
      return categoricalRamp(s, attr) || s.color || DEFAULT_COLOR;
    }
    if (s.mode === "numeric") {
      return numericRamp(s, attr) || s.color || DEFAULT_COLOR;
    }
    return s.color || DEFAULT_COLOR;
  }

  // MapLibre needs one layer per paint family. Which of the three we add
  // depends on the geometry, so a point layer doesn't carry a dead fill layer
  // that the opacity slider would still try to drive.
  function buildPaintLayers(config, ids) {
    const style = config.style || {};
    const color = styleExpression(style);
    const opacity = config.opacity != null ? config.opacity : 1;
    const family = config.geometryType || "Polygon";
    const layers = [];

    if (family === "Polygon") {
      layers.push({
        id: ids.fill,
        role: "fill",
        type: "fill",
        paint: {
          "fill-color": color,
          "fill-opacity": (style.fillOpacity != null ? style.fillOpacity : 0.18) * opacity,
        },
      });
    }
    if (family === "Polygon" || family === "LineString") {
      layers.push({
        id: ids.line,
        role: "line",
        type: "line",
        paint: {
          "line-color": color,
          "line-width": style.lineWidth != null ? style.lineWidth : 1.5,
          "line-opacity": opacity,
        },
      });
    }
    if (family === "Point") {
      layers.push({
        id: ids.circle,
        role: "circle",
        type: "circle",
        paint: {
          "circle-color": color,
          "circle-radius": style.radius != null ? style.radius : 5,
          "circle-opacity": 0.8 * opacity,
          "circle-stroke-color": "#0b0d0c",
          "circle-stroke-width": 0.5,
        },
      });
    }
    return layers;
  }

  // ---- Popups ----

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  // pg_tileserv flattens a jsonb `props` column into MVT properties as a JSON
  // string rather than as separate keys, so uploaded layers need unwrapping
  // before their attributes are readable.
  function normalizeProperties(properties) {
    const out = {};
    Object.entries(properties || {}).forEach(([key, value]) => {
      if (key === "props" && typeof value === "string") {
        try {
          Object.assign(out, JSON.parse(value));
          return;
        } catch (_) {
          /* fall through and show the raw string */
        }
      }
      out[key] = value;
    });
    return out;
  }

  function formatValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(4);
    }
    return String(value);
  }

  function popupHtml(feature, entry) {
    const props = normalizeProperties(feature.properties);
    const label = entry.labelColumn && props[entry.labelColumn];
    const rows = Object.entries(props)
      .filter(([key]) => key !== "geom")
      .map(
        ([key, value]) =>
          `<tr><th scope="row">${escapeHtml(key)}</th>` +
          `<td>${escapeHtml(formatValue(value))}</td></tr>`
      )
      .join("");

    return (
      `<div class="vector-popup">` +
      `<div class="vector-popup-title">${escapeHtml(
        label || entry.name || "Feature"
      )}</div>` +
      (rows
        ? `<table class="vector-popup-table">${rows}</table>`
        : `<p class="empty-hint">No attributes.</p>`) +
      `</div>`
    );
  }

  const api = {
    getTileBaseUrl,
    isConfigured,
    fetchCatalog,
    uploadGeoJson,
    deleteLayer,
    fetchBounds,
    fetchFeature,
    buildPaintLayers,
    styleExpression,
    normalizeProperties,
    popupHtml,
    CATEGORY_COLORS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VectorTiles = api;
})(typeof window !== "undefined" ? window : globalThis);
