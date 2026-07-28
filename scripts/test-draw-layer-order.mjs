#!/usr/bin/env node
/* Drawn polygons must stay above rasters added or reordered after drawing. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Minimal MapLibre stand-in: moveLayer with no beforeId lifts to the top.
function fakeMap(ids) {
  const layers = ids.slice();
  return {
    layers,
    getLayer: (id) => (layers.includes(id) ? { id } : undefined),
    moveLayer(id) {
      const at = layers.indexOf(id);
      if (at >= 0) layers.splice(at, 1);
      layers.push(id);
    },
  };
}

const DRAWN = [
  "drawn-polygons-fill",
  "drawn-polygons-line",
  "drawn-polygons-selected-line",
  "draw-active-line",
  "draw-active-vertices",
];

let map = null;
globalThis.window = { AppState: { getMap: () => map } };
require("../public/draw-tools.js");
const DrawTools = globalThis.window.DrawTools;

assert.equal(typeof DrawTools.raiseLayers, "function", "raiseLayers is part of the public surface");

// A raster added after drawing lands on top and would hide the 0.15-opacity fill.
map = fakeMap(["basemap", ...DRAWN, "raster-added-later"]);
DrawTools.raiseLayers();
assert.deepEqual(
  map.layers,
  ["basemap", "raster-added-later", ...DRAWN],
  "drawn layers are lifted back above a raster added after drawing"
);

// applyLayerOrder moves every user layer up; the drawn layers must follow.
map = fakeMap(["basemap", ...DRAWN, "raster-a", "raster-b"]);
DrawTools.raiseLayers();
assert.equal(
  map.layers.indexOf("drawn-polygons-fill") > map.layers.indexOf("raster-b"),
  true,
  "drawn fill sits above every reordered raster"
);
assert.equal(map.layers[0], "basemap", "the basemap stays pinned at the bottom");

// Nothing to raise before the draw tool has ever run, and no map at startup.
map = fakeMap(["basemap", "raster-a"]);
DrawTools.raiseLayers();
assert.deepEqual(map.layers, ["basemap", "raster-a"], "no-op when no drawn layers exist");

map = null;
assert.doesNotThrow(() => DrawTools.raiseLayers(), "no-op before the map is created");

console.log("Drawn polygon layer ordering is valid.");
