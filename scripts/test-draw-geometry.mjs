#!/usr/bin/env node
/* Validate the pure geometry math behind the circle/rectangle draw tools. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Geometry = require("../public/draw-geometry.js");

function approxEqual(a, b, tolerance, message) {
  assert.ok(Math.abs(a - b) <= tolerance, `${message} (got ${a}, expected ~${b})`);
}

// haversineMiles: zero distance to itself, and a known reference distance.
assert.equal(Geometry.haversineMiles([-83.5, 33.9], [-83.5, 33.9]), 0, "distance to self is 0");

// ~69 miles per degree of latitude, everywhere on the sphere.
approxEqual(Geometry.haversineMiles([0, 0], [0, 1]), 69.17, 0.5, "1 degree of latitude is ~69 miles");

// A geodesic circle must hold its radius at every bearing, including far
// from the equator where a degree-based "circle" would flatten into an
// ellipse. Check several centers and radii.
[
  { center: [-83.5, 33.9], radius: 10 }, // mid-latitude (Georgia)
  { center: [-83.5, 0], radius: 25 }, // equator
  { center: [-120, 65], radius: 50 }, // high latitude
].forEach(({ center, radius }) => {
  const ring = Geometry.circlePolygonCoords(center, radius);
  assert.ok(ring.length > 3, "circle ring has multiple vertices");
  ring.forEach((point) => {
    approxEqual(
      Geometry.haversineMiles(center, point),
      radius,
      radius * 0.001 + 0.01,
      `circle point at ${center} holds its ${radius}-mile radius`
    );
  });
  // The ring closes.
  assert.deepEqual(ring[0], ring[ring.length - 1], "circle ring closes on itself");
});

// destinationPoint at bearing 90 (east) from the equator moves lng+, lat unchanged.
{
  const dest = Geometry.destinationPoint([0, 0], 90, 69.17);
  approxEqual(dest[0], 1, 0.05, "due east at the equator increases longitude by ~1 degree");
  approxEqual(dest[1], 0, 0.01, "due east at the equator holds latitude");
}

// rectRingCoords: plain drag (no shift) is just the bounding box of the two corners.
{
  const ring = Geometry.rectRingCoords([-84, 34], [-83, 35], false);
  assert.deepEqual(ring, [
    [-84, 34],
    [-83, 34],
    [-83, 35],
    [-84, 35],
    [-84, 34],
  ]);
  assert.equal(Geometry.rectRingHasArea(ring), true);
}

// rectRingCoords: a degenerate drag (no movement) has no area.
{
  const ring = Geometry.rectRingCoords([-84, 34], [-84, 34], false);
  assert.equal(Geometry.rectRingHasArea(ring), false, "a zero-size drag has no area");
}

// rectRingCoords: shift forces equal width/height in screen pixels, using
// the given project/unproject. A linear 1:1 lng/lat<->pixel mapping makes
// the expected square easy to check directly.
{
  const project = (p) => ({ x: p[0], y: p[1] });
  const unproject = (p) => ({ lng: p[0], lat: p[1] });
  // Drag twice as far in x as in y — shift should clamp to the larger side.
  const ring = Geometry.rectRingCoords([0, 0], [10, 4], true, project, unproject);
  const width = ring[1][0] - ring[0][0];
  const height = ring[2][1] - ring[1][1];
  approxEqual(width, height, 1e-9, "shift constrains the rectangle to a square in pixel space");
  approxEqual(width, 10, 1e-9, "square side matches the larger of the two dragged extents");
}

// formatMilesValue: sensible precision at different magnitudes.
assert.equal(Geometry.formatMilesValue(0.4), "0.40");
assert.equal(Geometry.formatMilesValue(3.14159), "3.1");
assert.equal(Geometry.formatMilesValue(42.9), "43");

console.log("Draw geometry math is valid.");
