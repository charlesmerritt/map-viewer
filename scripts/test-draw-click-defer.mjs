#!/usr/bin/env node
/* A drawn polygon over a visible state/county must win the click. The
   state/county handlers defer to it via DrawTools.isPointOnDrawnPolygon();
   without that, both their handler and onDrawnPolygonClick fire for the same
   click and the selection flips to the boundary underneath. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DRAWN_FILL = "drawn-polygons-fill";

// Minimal MapLibre stand-in: records queryRenderedFeatures calls and returns
// `hits` synthetic features; getLayer knows the drawn-fill layer only when drawn.
function fakeMap({ hasFill = true, hits = 0 } = {}) {
  const calls = [];
  return {
    calls,
    getLayer: (id) => (hasFill && id === DRAWN_FILL ? { id } : undefined),
    queryRenderedFeatures(point, opts) {
      calls.push({ point, opts });
      return Array.from({ length: hits }, () => ({ type: "Feature" }));
    },
  };
}

let map = null;
globalThis.window = { AppState: { getMap: () => map } };
require("../public/draw-tools.js");
const DrawTools = globalThis.window.DrawTools;

assert.equal(
  typeof DrawTools.isPointOnDrawnPolygon,
  "function",
  "isPointOnDrawnPolygon is part of the public surface"
);

// No map yet → false, no throw.
map = null;
assert.equal(
  DrawTools.isPointOnDrawnPolygon({ x: 1, y: 2 }),
  false,
  "false before the map exists"
);

// Drawn-fill layer absent (nothing drawn yet) → false, and no query attempted.
map = fakeMap({ hasFill: false });
assert.equal(
  DrawTools.isPointOnDrawnPolygon({ x: 1, y: 2 }),
  false,
  "false when the drawn-fill layer does not exist"
);
assert.equal(map.calls.length, 0, "does not query when there is no drawn layer");

// Drawn layer present, nothing under the point → false; queries the right layer/point.
map = fakeMap({ hasFill: true, hits: 0 });
assert.equal(
  DrawTools.isPointOnDrawnPolygon({ x: 5, y: 6 }),
  false,
  "false when no drawn feature is under the point"
);
assert.deepEqual(map.calls[0].opts, { layers: [DRAWN_FILL] }, "queries only the drawn-fill layer");
assert.deepEqual(map.calls[0].point, { x: 5, y: 6 }, "queries at the given point");

// A drawn polygon under the point → true, so the boundary handler defers.
map = fakeMap({ hasFill: true, hits: 1 });
assert.equal(
  DrawTools.isPointOnDrawnPolygon({ x: 5, y: 6 }),
  true,
  "true when a drawn polygon is under the point"
);

console.log("Drawn polygon click deferral is valid.");
