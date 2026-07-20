/* ----------------------------------------------------------------
   zonal-engine.js — compute zonal statistics for a raster layer.

   Two engines behind one call:

   1. Client-side (geotiff.js + proj4, both already loaded): open the
      COG (range requests for URLs, ArrayBuffer for uploaded files),
      read only the window covering the polygon — stepping down to an
      overview, then to a decimated read, when the full-res window
      would be too large — reproject
      the polygon into the raster CRS, and run ZonalCore's scanline
      statistics. No server involved.

   2. TiTiler (`POST /cog/statistics`): used for D2S tile layers whose
      pixels never reach the browser. Falls back to the client engine
      if the endpoint is unavailable.

   Public surface (window.ZonalEngine):
     compute(layer, geometry) -> Promise<{ stats, meta }>
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const Core = window.ZonalCore;

  // Cap on pixels read per computation; ~4M floats keeps the scanline
  // pass under a second and memory modest even for CONUS-scale COGs.
  const MAX_WINDOW_PIXELS = 2048 * 2048;
  const HISTOGRAM_BINS = 20;

  const tiffCache = new Map(); // cache key -> Promise<GeoTIFF>

  // ---- CRS helpers (mirrors layers.js, which keeps them private) ----

  function getCrsFromGeoKeys(geoKeys) {
    if (geoKeys && geoKeys.ProjectedCSTypeGeoKey) {
      return "EPSG:" + geoKeys.ProjectedCSTypeGeoKey;
    }
    if (geoKeys && geoKeys.GeographicTypeGeoKey) {
      return "EPSG:" + geoKeys.GeographicTypeGeoKey;
    }
    return "EPSG:4326";
  }

  async function ensureProj4Def(crs) {
    if (!crs || crs === "EPSG:4326" || typeof proj4 === "undefined") return;
    try {
      proj4(crs);
      return; // already defined
    } catch (_) {}
    const code = crs.replace("EPSG:", "");
    const res = await fetch("https://epsg.io/" + code + ".proj4");
    if (!res.ok) throw new Error("Could not resolve projection " + crs);
    const def = await res.text();
    if (!def || !def.startsWith("+")) {
      throw new Error("Could not resolve projection " + crs);
    }
    proj4.defs(crs, def.trim());
  }

  // ---- Source resolution ----

  function currentTimestep(layer) {
    if (!Array.isArray(layer.times) || layer.times.length === 0) return null;
    const idx = layer.timeIndex ?? 0;
    return { ...layer.times[idx], index: idx };
  }

  function resolveRasterSource(layer) {
    const timestep = currentTimestep(layer);
    if (timestep) {
      return { kind: "url", url: timestep.url, label: timestep.label, cacheKey: layer.id + ":t" + timestep.index };
    }
    if (layer.type === "d2s-raster") {
      if (!layer.cogUrl) throw new Error("This tile layer has no COG URL to read from.");
      return { kind: "titiler", url: layer.cogUrl, cacheKey: layer.id };
    }
    const source = layer.source;
    if (source && source.kind === "file" && source.file) {
      return { kind: "file", file: source.file, cacheKey: layer.id };
    }
    if (source && source.url) {
      return { kind: "url", url: source.url, cacheKey: layer.id };
    }
    throw new Error("Cannot locate raster data for this layer.");
  }

  function openTiff(source) {
    const cached = tiffCache.get(source.cacheKey);
    if (cached) return cached;
    let promise;
    if (source.kind === "file") {
      promise = source.file.arrayBuffer().then((buf) => GeoTIFF.fromArrayBuffer(buf));
    } else {
      // fromUrl issues HTTP range requests, so only the polygon's
      // window is downloaded from a well-formed COG.
      promise = GeoTIFF.fromUrl(source.url);
    }
    promise.catch(() => tiffCache.delete(source.cacheKey));
    tiffCache.set(source.cacheKey, promise);
    return promise;
  }

  // ---- Client-side engine ----

  async function computeClientStats(tiff, geometry) {
    const image = await tiff.getImage();
    const bboxR = image.getBoundingBox(); // raster CRS [minX, minY, maxX, maxY]
    let geoKeys = {};
    try { geoKeys = image.getGeoKeys(); } catch (_) {}
    const crs = getCrsFromGeoKeys(geoKeys);
    await ensureProj4Def(crs);

    const project =
      crs === "EPSG:4326" || typeof proj4 === "undefined"
        ? null
        : (p) => proj4("EPSG:4326", crs, p);

    const rings = Core.projectRings(geometry, project);
    if (rings.length === 0) throw new Error("Geometry has no polygon rings.");
    const polyBBox = Core.ringsBBox(rings);
    const ibox = Core.intersectBBox(polyBBox, bboxR);
    if (!ibox) throw new Error("The polygon does not overlap this raster.");

    // Pick the finest image (full res first, then overviews) whose
    // window over the polygon stays under the pixel budget. COG
    // overviews share the full-res bounding box. A raster with no
    // overviews — or whose coarsest one is still too big — falls
    // through with a decimated read plan rather than a full-res one.
    const imageCount = await tiff.getImageCount();
    let chosen = null;
    for (let k = 0; k < imageCount; k++) {
      const candidate = k === 0 ? image : await tiff.getImage(k);
      const plan = Core.planReadWindow(
        bboxR,
        ibox,
        candidate.getWidth(),
        candidate.getHeight(),
        MAX_WINDOW_PIXELS
      );
      chosen = Object.assign({ image: candidate, level: k }, plan);
      if (plan.pixels <= MAX_WINDOW_PIXELS) break;
    }
    if (!chosen || chosen.x0 >= chosen.x1 || chosen.y0 >= chosen.y1) {
      throw new Error("The polygon does not overlap this raster.");
    }

    const readOptions = {
      window: [chosen.x0, chosen.y0, chosen.x1, chosen.y1],
      samples: [0],
    };
    if (chosen.downsampled) {
      readOptions.width = chosen.outWidth;
      readOptions.height = chosen.outHeight;
    }
    const rasters = await chosen.image.readRasters(readOptions);

    let noData = null;
    try { noData = image.getGDALNoData(); } catch (_) {}

    const stats = Core.computeGridStats(
      {
        values: rasters[0],
        width: chosen.outWidth,
        height: chosen.outHeight,
        originX: bboxR[0] + chosen.x0 * chosen.resX,
        originY: bboxR[3] - chosen.y0 * chosen.resY,
        resX: chosen.outResX,
        resY: chosen.outResY,
        noData,
      },
      rings,
      { histogramBins: HISTOGRAM_BINS }
    );

    return {
      stats,
      meta: {
        method: "client",
        crs,
        band: 1,
        overviewLevel: chosen.level,
        pixelSize: chosen.outResX,
        windowPixels: chosen.outWidth * chosen.outHeight,
        approximate: chosen.level > 0 || chosen.downsampled,
      },
    };
  }

  // ---- TiTiler engine ----

  async function computeTiTilerStats(cogUrl, geometry) {
    const base = window.D2S.getTiTilerBase();
    const params = new URLSearchParams({
      url: cogUrl,
      histogram_bins: String(HISTOGRAM_BINS),
    });
    const res = await fetch(`${base}/cog/statistics?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Feature", properties: {}, geometry }),
    });
    if (!res.ok) throw new Error(`TiTiler statistics failed: HTTP ${res.status}`);
    const data = await res.json();

    const properties =
      data.type === "FeatureCollection"
        ? data.features?.[0]?.properties
        : data.properties;
    const bands = properties && properties.statistics;
    const firstBand = bands && Object.keys(bands)[0];
    const s = firstBand ? bands[firstBand] : null;
    if (!s) throw new Error("TiTiler returned no statistics for this polygon.");

    return {
      stats: {
        count: s.count,
        nodataCount: s.masked_pixels ?? null,
        min: s.min,
        max: s.max,
        sum: s.sum,
        mean: s.mean,
        std: s.std,
        histogram: Array.isArray(s.histogram)
          ? { counts: s.histogram[0], edges: s.histogram[1] }
          : null,
      },
      meta: {
        method: "titiler",
        band: firstBand,
        median: s.median,
        validPercent: s.valid_percent,
      },
    };
  }

  // ---- Public entry point ----

  async function compute(layer, geometry) {
    const source = resolveRasterSource(layer);

    if (source.kind === "titiler") {
      try {
        const result = await computeTiTilerStats(source.url, geometry);
        result.meta.timestepLabel = source.label || null;
        return result;
      } catch (err) {
        console.warn("[zonal] TiTiler statistics failed, falling back to client-side:", err);
        const result = await computeClientStats(await openTiff({ ...source, kind: "url" }), geometry);
        result.meta.timestepLabel = source.label || null;
        return result;
      }
    }

    const result = await computeClientStats(await openTiff(source), geometry);
    result.meta.timestepLabel = source.label || null;
    return result;
  }

  window.ZonalEngine = { compute };
})();
