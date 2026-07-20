#!/usr/bin/env node
/* Validate the pure zonal-statistics math used by the in-browser engine. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Zonal = require("../public/zonal-core.js");

// 10x10 grid over CRS extent [0, 0, 10, 10]; value = row * 10 + col,
// rows counted from the top (originY = 10, resY = 1).
function makeGrid(overrides = {}) {
  const values = new Float64Array(100);
  for (let j = 0; j < 10; j++) {
    for (let i = 0; i < 10; i++) values[j * 10 + i] = j * 10 + i;
  }
  return {
    values,
    width: 10,
    height: 10,
    originX: 0,
    originY: 10,
    resX: 1,
    resY: 1,
    noData: null,
    ...overrides,
  };
}

function square(minX, minY, maxX, maxY) {
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

// ---- projectRings / bbox helpers ----

const multi = {
  type: "MultiPolygon",
  coordinates: [
    [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    [[[5, 5], [7, 5], [7, 7], [5, 7], [5, 5]]],
  ],
};
const rings = Zonal.projectRings(multi, null);
assert.equal(rings.length, 2, "MultiPolygon flattens into one ring per polygon");
assert.deepEqual(
  Zonal.ringsBBox(rings),
  [0, 0, 7, 7],
  "bbox spans all rings"
);
assert.deepEqual(
  Zonal.projectRings(multi, (p) => [p[0] * 2, p[1] * 2])[1][0],
  [10, 10],
  "projection function applies to every vertex"
);
assert.equal(
  Zonal.intersectBBox([0, 0, 2, 2], [3, 3, 5, 5]),
  null,
  "disjoint bboxes do not intersect"
);
assert.deepEqual(
  Zonal.intersectBBox([0, 0, 4, 4], [2, 2, 6, 6]),
  [2, 2, 4, 4],
  "overlapping bboxes clip to the shared extent"
);

// ---- basic square: rows 2-5, cols 2-5 (16 pixels) ----

const squareStats = Zonal.computeGridStats(makeGrid(), [square(2, 4, 6, 8)]);
assert.equal(squareStats.count, 16, "square polygon covers 16 pixel centers");
assert.equal(squareStats.sum, 616, "sum of covered values");
assert.equal(squareStats.mean, 38.5, "mean of covered values");
assert.equal(squareStats.min, 22, "min of covered values");
assert.equal(squareStats.max, 55, "max of covered values");
assert.equal(squareStats.nodataCount, 0, "no nodata in clean grid");
assert.equal(
  squareStats.histogram.counts.reduce((a, b) => a + b, 0),
  squareStats.count,
  "histogram counts add up to the valid pixel count"
);
assert.equal(squareStats.histogram.edges[0], squareStats.min, "histogram starts at min");
assert.equal(
  squareStats.histogram.edges[squareStats.histogram.counts.length],
  squareStats.max,
  "histogram ends at max"
);

// ---- polygon with a hole ----

const holeStats = Zonal.computeGridStats(makeGrid(), [
  square(0, 0, 10, 10),
  square(2, 2, 8, 8), // hole: excludes centers 2.5–7.5 in both axes (36 px)
]);
assert.equal(holeStats.count, 64, "hole ring excludes interior pixels (even-odd)");

// ---- multipolygon: two disjoint 2x2 squares ----

const multiStats = Zonal.computeGridStats(
  makeGrid(),
  Zonal.projectRings(
    {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 8], [2, 8], [2, 10], [0, 10], [0, 8]]],
        [[[8, 0], [10, 0], [10, 2], [8, 2], [8, 0]]],
      ],
    },
    null
  )
);
assert.equal(multiStats.count, 8, "disjoint multipolygon parts both counted");
assert.equal(multiStats.min, 0, "top-left square contains value 0");
assert.equal(multiStats.max, 99, "bottom-right square contains value 99");

// ---- nodata and NaN handling ----

const noDataGrid = makeGrid({ noData: -9999 });
noDataGrid.values[2 * 10 + 2] = -9999; // inside the square polygon
noDataGrid.values[2 * 10 + 3] = NaN;
const noDataStats = Zonal.computeGridStats(noDataGrid, [square(2, 4, 6, 8)]);
assert.equal(noDataStats.count, 14, "nodata and NaN pixels excluded from count");
assert.equal(noDataStats.nodataCount, 2, "nodata and NaN pixels counted separately");
assert.equal(noDataStats.sum, 616 - 22 - 23, "sum skips excluded pixels");

// ---- no overlap / all nodata ----

const missStats = Zonal.computeGridStats(makeGrid(), [square(20, 20, 30, 30)]);
assert.equal(missStats.count, 0, "polygon outside the grid matches nothing");
assert.equal(missStats.histogram, null, "no histogram without valid pixels");

const allNoData = makeGrid({ noData: 0, values: new Float64Array(100) });
const allNoDataStats = Zonal.computeGridStats(allNoData, [square(0, 0, 10, 10)]);
assert.equal(allNoDataStats.count, 0, "all-nodata window yields zero valid pixels");
assert.equal(allNoDataStats.nodataCount, 100, "all pixels reported as nodata");

// ---- constant values: std 0, degenerate histogram ----

const constGrid = makeGrid({ values: new Float64Array(100).fill(7) });
const constStats = Zonal.computeGridStats(constGrid, [square(0, 0, 10, 10)]);
assert.equal(constStats.std, 0, "constant raster has zero stddev");
assert.equal(constStats.min, constStats.max, "constant raster min equals max");
assert.equal(
  constStats.histogram.counts.reduce((a, b) => a + b, 0),
  100,
  "degenerate histogram still counts every pixel"
);

// ---- triangle: partial pixel coverage uses pixel centers ----

const triStats = Zonal.computeGridStats(makeGrid(), [
  [[0, 0], [9, 0], [0, 9]],
]);
assert.equal(triStats.count, 45, "triangle covers pixels whose centers fall inside");

console.log("Zonal statistics core is valid.");
