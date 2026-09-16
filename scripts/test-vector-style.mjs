#!/usr/bin/env node
/* Tests for public/vector-tiles.js styling and popup helpers.

   The module is a browser IIFE that assigns window.VectorTiles, so it is
   evaluated here against a minimal window stub — the same approach the
   layer-group and zonal-core tests take. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The module falls back to globalThis when there is no window, so the tile
// base URL is configured by setting __ENV there before requiring it.
globalThis.__ENV = { VECTOR_TILE_BASE_URL: "https://tiles.example.com/" };

const require = createRequire(import.meta.url);
const V = require("../public/vector-tiles.js");

// ---- Tile base URL ----

assert.equal(
  V.getTileBaseUrl(),
  "https://tiles.example.com",
  "trailing slash is stripped so tile paths do not double up"
);
assert.equal(V.isConfigured(), true);

// ---- styleExpression ----

assert.equal(
  V.styleExpression({ color: "#abcdef" }),
  "#abcdef",
  "no attribute means a flat colour"
);
assert.equal(
  V.styleExpression({ color: "#abcdef", mode: "numeric", attribute: "biomass" }),
  "#abcdef",
  "a numeric ramp without a usable min/max falls back to the flat colour"
);

const numeric = V.styleExpression({
  mode: "numeric",
  attribute: "biomass",
  min: 0,
  max: 100,
});
assert.ok(Array.isArray(numeric), "a valid numeric ramp produces an expression");
assert.equal(numeric[0], "interpolate");
assert.deepEqual(numeric[2], ["to-number", ["get", "biomass"], 0]);
assert.equal(numeric[3], 0, "first stop is the configured minimum");
assert.equal(
  numeric[numeric.length - 2],
  100,
  "last stop is the configured maximum"
);

assert.equal(
  V.styleExpression({ mode: "numeric", attribute: "b", min: 5, max: 5 }),
  "#6ab048",
  "a zero-width range cannot make a ramp and falls back"
);

const categorical = V.styleExpression({
  mode: "categorical",
  attribute: "species",
  categories: ["pine", "oak"],
});
assert.equal(categorical[0], "match");
assert.deepEqual(categorical[1], ["to-string", ["get", "species"]]);
assert.equal(categorical[2], "pine");
assert.equal(categorical[4], "oak");
assert.equal(
  categorical.length,
  7,
  "match expression ends with a single fallback colour"
);

assert.equal(
  V.styleExpression({ mode: "categorical", attribute: "species", categories: [] }),
  "#6ab048",
  "no categories falls back rather than emitting an invalid match"
);

// ---- buildPaintLayers ----

const ids = { fill: "f", line: "l", circle: "c" };

const polygonLayers = V.buildPaintLayers(
  { geometryType: "Polygon", opacity: 0.5, style: {} },
  ids
);
assert.deepEqual(
  polygonLayers.map((l) => l.role),
  ["fill", "line"],
  "polygons get a fill and a line, not a circle"
);
assert.equal(
  polygonLayers[0].paint["fill-opacity"],
  0.09,
  "layer opacity multiplies the style's fill opacity"
);

assert.deepEqual(
  V.buildPaintLayers({ geometryType: "LineString", style: {} }, ids).map((l) => l.role),
  ["line"],
  "lines get only a line layer"
);

const pointLayers = V.buildPaintLayers({ geometryType: "Point", style: {} }, ids);
assert.deepEqual(
  pointLayers.map((l) => l.role),
  ["circle"],
  "points get only a circle layer"
);
assert.equal(pointLayers[0].type, "circle");

// ---- normalizeProperties ----

assert.deepEqual(
  V.normalizeProperties({ props: '{"a":1,"b":"x"}', id: 7 }),
  { a: 1, b: "x", id: 7 },
  "a jsonb props column arriving as a JSON string is unwrapped"
);
assert.deepEqual(
  V.normalizeProperties({ props: "not json" }),
  { props: "not json" },
  "an unparseable props value is shown as-is rather than dropped"
);
assert.deepEqual(
  V.normalizeProperties({ name: "Autauga" }),
  { name: "Autauga" },
  "ordinary columns pass through untouched"
);

// ---- popupHtml ----

const html = V.popupHtml(
  { properties: { name: "Autauga", geoid: "01001" } },
  { labelColumn: "name", name: "US counties" }
);
assert.match(html, /Autauga/, "uses the label column for the title");
assert.match(html, /01001/, "lists the other attributes");

const escaped = V.popupHtml(
  { properties: { name: '<img src=x onerror="alert(1)">' } },
  { labelColumn: "name", name: "L" }
);
assert.ok(
  !escaped.includes("<img"),
  "attribute values are escaped rather than injected as markup"
);
assert.match(escaped, /&lt;img/);

console.log("vector style tests passed");
