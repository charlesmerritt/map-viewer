/* ----------------------------------------------------------------
   draw-geometry.js — pure geometry math for the drawing tools (no
   DOM, no MapLibre). Kept separate from draw-tools.js so it can run
   in Node for tests, mirroring zonal-core.js.

   A circle described by a radius in miles must be computed on the
   sphere, not as a fixed-degree offset — a degree-based "circle"
   turns into a visibly flattened ellipse away from the equator.
   ---------------------------------------------------------------- */

(function (root) {
  "use strict";

  const EARTH_RADIUS_MILES = 3958.8;

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function toDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  /** Great-circle distance between two [lng, lat] points, in miles. */
  function haversineMiles(a, b) {
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const s =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** [lng, lat] reached from `center` after travelling `distanceMiles` along `bearingDeg` (0 = north). */
  function destinationPoint(center, bearingDeg, distanceMiles) {
    const delta = distanceMiles / EARTH_RADIUS_MILES;
    const theta = toRad(bearingDeg);
    const phi1 = toRad(center[1]);
    const lambda1 = toRad(center[0]);
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
      );
    return [toDeg(lambda2), toDeg(phi2)];
  }

  /** Closed ring of `steps` geodesic points, radiusMiles from `center` in every direction. */
  function circlePolygonCoords(center, radiusMiles, steps) {
    const n = steps || 72;
    const ring = [];
    for (let i = 0; i <= n; i++) {
      ring.push(destinationPoint(center, (360 * i) / n, radiusMiles));
    }
    return ring;
  }

  /**
   * Closed axis-aligned rectangle ring from two corners. When `shift` is
   * true, the second corner is replaced by the point that makes the
   * rectangle a square in screen pixels at the current view, using
   * `project`/`unproject` (MapLibre's map.project/map.unproject).
   */
  function rectRingCoords(start, end, shift, project, unproject) {
    let corner2 = end;
    if (shift && project && unproject) {
      const p1 = project(start);
      const p2 = project(end);
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      const squared = unproject([p1.x + (dx < 0 ? -side : side), p1.y + (dy < 0 ? -side : side)]);
      corner2 = [squared.lng, squared.lat];
    }
    const minLng = Math.min(start[0], corner2[0]);
    const maxLng = Math.max(start[0], corner2[0]);
    const minLat = Math.min(start[1], corner2[1]);
    const maxLat = Math.max(start[1], corner2[1]);
    return [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ];
  }

  function rectRingHasArea(ring) {
    return ring[0][0] !== ring[2][0] && ring[0][1] !== ring[2][1];
  }

  function formatMilesValue(value) {
    if (value >= 10) return String(Math.round(value));
    if (value >= 1) return value.toFixed(1);
    return value.toFixed(2);
  }

  const api = {
    EARTH_RADIUS_MILES,
    haversineMiles,
    destinationPoint,
    circlePolygonCoords,
    rectRingCoords,
    rectRingHasArea,
    formatMilesValue,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.DrawGeometry = api;
})(typeof window !== "undefined" ? window : globalThis);
