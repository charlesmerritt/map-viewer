/* ----------------------------------------------------------------
   zonal-core.js — pure zonal-statistics math (no DOM, no GeoTIFF).

   Everything here operates on plain arrays so it can run in Node for
   tests and in the browser inside zonal-engine.js. Coordinates are in
   the raster's CRS; callers are responsible for reprojection.
   ---------------------------------------------------------------- */

(function (root) {
  "use strict";

  /**
   * Flatten a GeoJSON Polygon/MultiPolygon into an array of rings,
   * applying `project([x, y]) -> [x, y]` to every vertex. Holes stay
   * separate rings; even-odd filling handles them.
   */
  function projectRings(geometry, project) {
    if (!geometry) return [];
    const fn = project || ((p) => p);
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    const rings = [];
    polygons.forEach((polygon) => {
      polygon.forEach((ring) => {
        const projected = ring.map((point) => fn([point[0], point[1]]));
        if (projected.length >= 3) rings.push(projected);
      });
    });
    return rings;
  }

  function ringsBBox(rings) {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach((ring) => {
      ring.forEach((point) => {
        bbox[0] = Math.min(bbox[0], point[0]);
        bbox[1] = Math.min(bbox[1], point[1]);
        bbox[2] = Math.max(bbox[2], point[0]);
        bbox[3] = Math.max(bbox[3], point[1]);
      });
    });
    return bbox.every(Number.isFinite) ? bbox : null;
  }

  function intersectBBox(a, b) {
    const out = [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3]),
    ];
    if (out[0] >= out[2] || out[1] >= out[3]) return null;
    return out;
  }

  /**
   * Even-odd scanline crossings: x coordinates where the horizontal
   * line at `y` crosses ring edges, sorted ascending. Consecutive
   * pairs bound "inside" spans.
   */
  function rowCrossings(rings, y) {
    const xs = [];
    rings.forEach((ring) => {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        if (y1 === y2) continue;
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
          xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
    });
    xs.sort((a, b) => a - b);
    return xs;
  }

  /**
   * Compute zonal statistics for a raster window.
   *
   * grid: {
   *   values,        // flat array/TypedArray, row-major, length width*height
   *   width, height,
   *   originX,       // CRS x of the window's left edge
   *   originY,       // CRS y of the window's TOP edge
   *   resX,          // pixel width  (positive)
   *   resY,          // pixel height (positive; rows go top->down)
   *   noData,        // value to treat as nodata, or null
   * }
   * rings: projected polygon rings in the same CRS.
   *
   * Returns { count, nodataCount, min, max, sum, mean, std,
   *           histogram: { counts, edges } } — count is the number of
   * valid pixels whose centers fall inside the polygon.
   */
  function computeGridStats(grid, rings, options) {
    const opts = options || {};
    const bins = opts.histogramBins || 20;
    const { values, width, height, originX, originY, resX, resY } = grid;
    const noData = grid.noData;

    let count = 0;
    let nodataCount = 0;
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    const rowSpans = new Array(height);

    for (let j = 0; j < height; j++) {
      const y = originY - (j + 0.5) * resY;
      const xs = rowCrossings(rings, y);
      const spans = [];
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // Pixel column i has center originX + (i + 0.5) * resX.
        let i0 = Math.ceil((xs[k] - originX) / resX - 0.5);
        let i1 = Math.floor((xs[k + 1] - originX) / resX - 0.5);
        if (i0 < 0) i0 = 0;
        if (i1 > width - 1) i1 = width - 1;
        if (i0 > i1) continue;
        spans.push([i0, i1]);
        const rowOffset = j * width;
        for (let i = i0; i <= i1; i++) {
          const v = values[rowOffset + i];
          if (v == null || Number.isNaN(v) || (noData != null && v === noData)) {
            nodataCount++;
            continue;
          }
          count++;
          sum += v;
          sumSq += v * v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      rowSpans[j] = spans;
    }

    if (count === 0) {
      return {
        count: 0,
        nodataCount,
        min: null,
        max: null,
        sum: null,
        mean: null,
        std: null,
        histogram: null,
      };
    }

    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const std = Math.sqrt(variance);

    // Second pass over the recorded spans for the histogram.
    const counts = new Array(bins).fill(0);
    const range = max - min;
    for (let j = 0; j < height; j++) {
      const spans = rowSpans[j];
      if (!spans) continue;
      const rowOffset = j * width;
      spans.forEach(([i0, i1]) => {
        for (let i = i0; i <= i1; i++) {
          const v = values[rowOffset + i];
          if (v == null || Number.isNaN(v) || (noData != null && v === noData)) continue;
          let bin = range === 0 ? 0 : Math.floor(((v - min) / range) * bins);
          if (bin >= bins) bin = bins - 1;
          counts[bin]++;
        }
      });
    }
    const edges = new Array(bins + 1);
    for (let b = 0; b <= bins; b++) {
      edges[b] = range === 0 ? min : min + (range * b) / bins;
    }

    return {
      count,
      nodataCount,
      min,
      max,
      sum,
      mean,
      std,
      histogram: { counts, edges },
    };
  }

  const api = {
    projectRings,
    ringsBBox,
    intersectBBox,
    rowCrossings,
    computeGridStats,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.ZonalCore = api;
})(typeof window !== "undefined" ? window : globalThis);
