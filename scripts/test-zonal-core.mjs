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

// ---- planReadWindow: the pixel budget holds with or without overviews ----

// 1000x1000 image over [0, 0, 1000, 1000]; polygon covers a 100x100 window.
const smallPlan = Zonal.planReadWindow([0, 0, 1000, 1000], [10, 10, 110, 110], 1000, 1000, 4000);
assert.deepEqual(
  [smallPlan.x0, smallPlan.x1, smallPlan.y0, smallPlan.y1],
  [10, 110, 890, 990],
  "window is derived from the intersection box, y counted from the top"
);
assert.equal(smallPlan.pixels, 10000, "window pixel count is width * height");
assert.equal(smallPlan.downsampled, true, "10000 pixels exceeds the 4000 budget");
assert.ok(
  smallPlan.outWidth * smallPlan.outHeight <= 4000,
  "decimated read stays inside the budget"
);
assert.equal(smallPlan.outResX, (100 * 1) / smallPlan.outWidth, "resolution scales with the read size");

const underBudget = Zonal.planReadWindow([0, 0, 1000, 1000], [10, 10, 110, 110], 1000, 1000, 4000000);
assert.equal(underBudget.downsampled, false, "a window under the budget is read as-is");
assert.equal(underBudget.outWidth, 100, "undecimated read keeps the full window width");
assert.equal(underBudget.outResX, 1, "undecimated read keeps the native pixel size");

// The regression: the whole image with no overview to fall back on.
const noOverview = Zonal.planReadWindow([0, 0, 40000, 40000], [0, 0, 40000, 40000], 40000, 40000, 2048 * 2048);
assert.equal(noOverview.pixels, 40000 * 40000, "full-res window is far over the budget");
assert.ok(
  noOverview.outWidth * noOverview.outHeight <= 2048 * 2048,
  "coarsest-level overflow is still capped instead of read at full resolution"
);

const degenerate = Zonal.planReadWindow([0, 0, 10, 10], [10, 10, 10, 10], 10, 10, 100);
assert.equal(degenerate.pixels, 0, "an empty intersection yields no pixels");
assert.equal(degenerate.downsampled, false, "an empty window is not decimated");

// ---- sampleFactor: native pixels represented by one read pixel ----

assert.equal(Zonal.sampleFactor(1, 1, 1, 1), 1, "a full-resolution read represents itself");
assert.equal(Zonal.sampleFactor(4, 4, 1, 1), 16, "a 4x-per-dim read pixel covers 16 native pixels");
assert.equal(Zonal.sampleFactor(2, 2, 1, 1), 4, "a factor-2 overview pixel covers 4 native pixels");
assert.equal(Zonal.sampleFactor(1, 1, 0, 0), 1, "a degenerate native size falls back to 1");

// ---- scaling a decimated read recovers the true total (constant field) ----

// 100x100 native raster of constant 3 over [0,0,100,100]; a polygon
// covering the whole extent has a true sum of 30000 over 10000 pixels.
const plan = Zonal.planReadWindow([0, 0, 100, 100], [0, 0, 100, 100], 100, 100, 625);
assert.equal(plan.downsampled, true, "the full window is forced below the 625 budget");
assert.equal(plan.outWidth, 25, "decimated to 25 columns");
assert.equal(plan.outResX, 4, "read resolution coarsens to 4 CRS units/pixel");

// Simulate the decimated read: a 25x25 grid of the same constant value.
const sampled = Zonal.computeGridStats(
  {
    values: new Float64Array(plan.outWidth * plan.outHeight).fill(3),
    width: plan.outWidth,
    height: plan.outHeight,
    originX: 0,
    originY: 100,
    resX: plan.outResX,
    resY: plan.outResY,
    noData: null,
  },
  [square(0, 0, 100, 100)]
);
assert.equal(sampled.count, 625, "the decimated read sees 625 pixels");
assert.equal(sampled.sum, 1875, "sampled sum is short of the true total");

const factor = Zonal.sampleFactor(plan.outResX, plan.outResY, 1, 1);
assert.equal(Math.round(sampled.count * factor), 10000, "scaled count recovers the true pixel count");
assert.equal(sampled.sum * factor, 30000, "scaled sum recovers the true polygon total");
assert.equal((sampled.sum * factor) / (sampled.count * factor), sampled.mean, "scaling preserves mean = sum / count");

console.log("Zonal statistics core is valid.");
