/* ----------------------------------------------------------------
   layers.js — load, render, and manage map layers.

   Public surface (window.Layers):
     addLayerFromConfig(config)
     setLayerVisible(layer, visible)
     setLayerOpacity(layer, opacity)
     setLayerTimeIndex(layer, idx)
     removeLayer(layer)
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;

  // ---- Type detection ----

  function detectType(urlOrName, explicit) {
    if (explicit && explicit !== "auto") return explicit;
    const s = (urlOrName || "").toLowerCase().split("?")[0];
    if (s.endsWith(".tif") || s.endsWith(".tiff") || s.endsWith(".cog")) return "cog";
    if (s.endsWith(".geojson") || s.endsWith(".json")) return "geojson";
    return null;
  }

  // ---- File helpers ----

  function readFileBuffer(file) {
    if (typeof file.arrayBuffer === "function") {
      return file.arrayBuffer();
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsArrayBuffer(file);
    });
  }

  async function validateGeotiff(buffer) {
    if (typeof GeoTIFF === "undefined") return;
    let tiff;
    try {
      tiff = await GeoTIFF.fromArrayBuffer(buffer);
    } catch (err) {
      throw new Error(
        "Could not parse file as TIFF/GeoTIFF. " +
          (err.message || "The file may be corrupt or not a valid TIFF.")
      );
    }
    const image = await tiff.getImage();

    let hasGeoreferencing = false;
    try {
      const geoKeys = await image.getGeoKeys();
      if (geoKeys && Object.keys(geoKeys).length > 0) {
        hasGeoreferencing = true;
      }
    } catch (_) {
      /* some files lack geo keys */
    }

    if (!hasGeoreferencing) {
      try {
        const bbox = image.getBoundingBox();
        const w = image.getWidth();
        const h = image.getHeight();
        if (
          bbox &&
          bbox.length === 4 &&
          !(bbox[0] === 0 && bbox[1] === h && bbox[2] === w && bbox[3] === 0)
        ) {
          hasGeoreferencing = true;
        }
      } catch (_) {
        /* no bounding box available */
      }
    }

    if (!hasGeoreferencing) {
      throw new Error(
        "This TIFF file lacks georeferencing metadata. " +
          "Please use a GeoTIFF file (e.g., exported with GDAL or QGIS with CRS information)."
      );
    }
  }

  // ---- Raster styling ----

  function makePixelFn(georaster, style) {
    if (!style || !style.colormap || !window.chroma) return null;

    const scale = chroma.scale(style.colormap);
    const min =
      style.min != null && !Number.isNaN(Number(style.min))
        ? Number(style.min)
        : georaster.mins[0];
    const max =
      style.max != null && !Number.isNaN(Number(style.max))
        ? Number(style.max)
        : georaster.maxs[0];
    const noData = georaster.noDataValue;
    const range = max - min;

    return function (values) {
      const v = values[0];
      if (
        v === null ||
        v === undefined ||
        Number.isNaN(v) ||
        (noData != null && v === noData)
      ) {
        return null;
      }
      const t = range === 0 ? 0.5 : (v - min) / range;
      const clamped = Math.max(0, Math.min(1, t));
      return scale(clamped).hex();
    };
  }

  // ---- MapLibre source id helpers ----

  function sourceId(layerId, suffix) {
    return layerId + "_" + suffix;
  }

  // ---- GeoTIFF → canvas rendering ----

  function normalizeToCanvas(rasters, width, height, style) {
    const numBands = rasters.length;
    // Cap canvas size for very large imagery (e.g. NAIP, Landfire)
    const MAX_DIM = 4096;
    const MAX_PIXELS = 4096 * 4096;
    let outW = width;
    let outH = height;
    if (width > MAX_DIM || height > MAX_DIM || width * height > MAX_PIXELS) {
      const scale = Math.min(MAX_DIM / width, MAX_DIM / height, Math.sqrt(MAX_PIXELS / (width * height)));
      outW = Math.max(1, Math.round(width * scale));
      outH = Math.max(1, Math.round(height * scale));
      console.log(`[layers] Downsampling canvas from ${width}x${height} to ${outW}x${outH}`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(outW, outH);

    const band0Val = rasters[0][0];
    const isFloat = typeof band0Val === "number" && !Number.isInteger(band0Val);

    let min = 0;
    let max = 255;
    if (numBands < 3) {
      if (style && style.colormap && window.chroma) {
        min =
          style.min != null && !Number.isNaN(Number(style.min))
            ? Number(style.min)
            : Infinity;
        max =
          style.max != null && !Number.isNaN(Number(style.max))
            ? Number(style.max)
            : -Infinity;
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          for (let i = 0; i < width * height; i++) {
            const v = rasters[0][i];
            if (v == null || Number.isNaN(v)) continue;
            if (!Number.isFinite(min)) min = Math.min(min, v);
            if (!Number.isFinite(max)) max = Math.max(max, v);
          }
          if (!Number.isFinite(min)) min = 0;
          if (!Number.isFinite(max)) max = 1;
        }
      } else {
        let dataMin = Infinity;
        let dataMax = -Infinity;
        for (let i = 0; i < width * height; i++) {
          const v = rasters[0][i];
          if (v == null || Number.isNaN(v)) continue;
          dataMin = Math.min(dataMin, v);
          dataMax = Math.max(dataMax, v);
        }
        if (Number.isFinite(dataMin) && Number.isFinite(dataMax) && dataMax > dataMin) {
          min = dataMin;
          max = dataMax;
        } else if (isFloat) {
          min = 0;
          max = 1;
        }
      }
    }

    const range = max - min || 1;
    const colorScale = (numBands < 3 && style && style.colormap && window.chroma) ? chroma.scale(style.colormap) : null;
    const xRatio = width / outW;
    const yRatio = height / outH;

    for (let oy = 0; oy < outH; oy++) {
      const sy = Math.min(Math.floor(oy * yRatio), height - 1);
      for (let ox = 0; ox < outW; ox++) {
        const sx = Math.min(Math.floor(ox * xRatio), width - 1);
        const si = sy * width + sx;
        const di = (oy * outW + ox) * 4;
        if (numBands >= 3) {
          img.data[di]     = clampByte(rasters[0][si]);
          img.data[di + 1] = clampByte(rasters[1][si]);
          img.data[di + 2] = clampByte(rasters[2][si]);
          img.data[di + 3] = 255;
        } else {
          const v = rasters[0][si];
          if (v == null || Number.isNaN(v)) {
            img.data[di + 3] = 0;
          } else if (colorScale) {
            const t = (v - min) / range;
            const c = colorScale(Math.max(0, Math.min(1, t))).rgb();
            img.data[di]     = c[0];
            img.data[di + 1] = c[1];
            img.data[di + 2] = c[2];
            img.data[di + 3] = 255;
          } else {
            const b = clampByte(((v - min) / range) * 255);
            img.data[di]     = b;
            img.data[di + 1] = b;
            img.data[di + 2] = b;
            img.data[di + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function clampByte(v) {
    if (v == null || Number.isNaN(v)) return 0;
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  async function renderGeotiff(buffer, style) {
    const tiff = await GeoTIFF.fromArrayBuffer(buffer);
    let image = await tiff.getImage();
    let width = image.getWidth();
    let height = image.getHeight();
    
    // For very large images, try to use overview/pyramid if available
    const MAX_PIXELS = 2048 * 2048;
    if (width * height > MAX_PIXELS) {
      const imageCount = await tiff.getImageCount();
      if (imageCount > 1) {
        // Try to find a suitable overview
        for (let i = 1; i < imageCount; i++) {
          const overview = await tiff.getImage(i);
          const ow = overview.getWidth();
          const oh = overview.getHeight();
          if (ow * oh <= MAX_PIXELS) {
            console.log(`[layers] Using overview ${i} (${ow}x${oh}) instead of full res (${width}x${height})`);
            image = overview;
            width = ow;
            height = oh;
            break;
          }
        }
      }
    }
    
    let rasters;
    try {
      rasters = await image.readRasters({ interleave: false });
    } catch (err) {
      throw new Error(
        `Failed to read raster data (${width}x${height}px). ` +
        `File may be too large or corrupted. Try a smaller file or Cloud-Optimized GeoTIFF. ` +
        `Original error: ${err.message || err}`
      );
    }
    
    const canvas = normalizeToCanvas(rasters, width, height, style);
    return { canvas, image };
  }

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
    try {
      const res = await fetch("https://epsg.io/" + code + ".proj4");
      if (res.ok) {
        const def = await res.text();
        if (def && def.startsWith("+")) {
          proj4.defs(crs, def.trim());
          console.log("[layers] registered proj4 def for", crs);
        }
      }
    } catch (err) {
      console.warn("[layers] could not fetch proj4 def for", crs, err);
    }
  }

  function reprojectCorner(x, y, fromCrs) {
    if (fromCrs === "EPSG:4326" || typeof proj4 === "undefined") {
      return [x, y];
    }
    try {
      return proj4(fromCrs, "EPSG:4326", [x, y]);
    } catch (err) {
      console.warn("[layers] proj4 reprojection failed:", err);
      return [x, y];
    }
  }

  async function extractGeotiffBounds(buffer) {
    const tiff = await GeoTIFF.fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
    let geoKeys = {};
    try { geoKeys = image.getGeoKeys(); } catch (_) {}
    const crs = getCrsFromGeoKeys(geoKeys);
    await ensureProj4Def(crs);

    const tl = reprojectCorner(bbox[0], bbox[3], crs);
    const tr = reprojectCorner(bbox[2], bbox[3], crs);
    const br = reprojectCorner(bbox[2], bbox[1], crs);
    const bl = reprojectCorner(bbox[0], bbox[1], crs);

    return {
      coordinates: [tl, tr, br, bl],
      bbox4326: [Math.min(tl[0], bl[0]), Math.min(bl[1], br[1]), Math.max(tr[0], br[0]), Math.max(tl[1], tr[1])],
    };
  }

  // ---- COG loader (MapLibre image source) ----

  async function probeRaster(url) {
    let probe;
    try {
      probe = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-15" },
      });
    } catch (err) {
      throw new Error(
        "Network/CORS error fetching " + url + ". The host probably doesn't allow " +
          "cross-origin requests. Try downloading the file and using the " +
          "\"Upload file\" tab, or host the COG on a CORS-enabled bucket."
      );
    }

    if (!probe.ok && probe.status !== 206) {
      throw new Error(
        "HTTP " + probe.status + " " + probe.statusText + " fetching raster. " +
          "URL may require auth or has moved."
      );
    }

    const buffer = await probe.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isLE = bytes[0] === 0x49 && bytes[1] === 0x49; // 'II'
    const isBE = bytes[0] === 0x4d && bytes[1] === 0x4d; // 'MM'

    if (!isLE && !isBE) {
      let preview = "";
      try {
        preview = new TextDecoder().decode(bytes.slice(0, 80)).trim();
      } catch (_) {
        /* binary garbage */
      }
      throw new Error(
        "URL did not return a TIFF — expected 'II' or 'MM' magic, got " +
          "bytes [" + bytes[0] + ", " + bytes[1] + "]. " +
          (preview.startsWith("<")
            ? "Looks like HTML was returned (\"" + preview.slice(0, 40) + "…\") — " +
              "likely a CORS error page, login redirect, or 404. "
            : "") +
          "If the source server doesn't support CORS, download the .tif and " +
          "use the \"Upload file\" tab instead."
      );
    }

    const contentRange = probe.headers.get("content-range");
    const supportsRange = probe.status === 206 && !!contentRange;
    return { supportsRange };
  }

  async function loadCog(source, style) {
    if (typeof GeoTIFF === "undefined") {
      throw new Error("geotiff.js library failed to load");
    }

    let buffer;
    let isLargeFile = false;
    
    if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
      buffer = source;
      isLargeFile = buffer.byteLength > 10 * 1024 * 1024; // >10MB
    } else if (typeof source === "string") {
      const { supportsRange } = await probeRaster(source);
      if (supportsRange) {
        console.warn(
          "[layers] " + source + ": downloading whole file for canvas rendering."
        );
      }
      const full = await fetch(source);
      if (!full.ok) {
        throw new Error(
          "HTTP " + full.status + " " + full.statusText + " downloading raster"
        );
      }
      buffer = await full.arrayBuffer();
      isLargeFile = buffer.byteLength > 10 * 1024 * 1024;
    } else {
      throw new Error("Unsupported raster source type");
    }

    await validateGeotiff(buffer);

    // Check dimensions
    const tiff = await GeoTIFF.fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const isLargeDimensions = width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024;

    if (isLargeFile || isLargeDimensions) {
      console.warn(
        `[layers] Large COG detected (${width}x${height}, ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). ` +
        `For optimal performance with CONUS-scale imagery, consider using a tile server or hosting as a proper COG with overviews.`
      );
    }

    const [{ canvas, image: img }, bounds] = await Promise.all([
      renderGeotiff(buffer, style),
      extractGeotiffBounds(buffer),
    ]);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      coordinates: bounds.coordinates,
      bounds: bounds.bbox4326,
      width: img.getWidth(),
      height: img.getHeight(),
    };
  }

  // ---- GeoJSON loader (MapLibre) ----

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  async function loadGeoJsonUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching GeoJSON");
    return await res.json();
  }
  async function loadGeoJsonFile(file) {
    const text = await file.text();
    return JSON.parse(text);
  }

  // ---- Unified loader ----

  async function loadLayerData(type, source, style) {
    if (type === "cog") {
      if (source.kind === "file") {
        const buffer = await readFileBuffer(source.file);
        return loadCog(buffer, style);
      }
      return loadCog(source.url, style);
    }
    if (type === "geojson") {
      if (source.kind === "file") return loadGeoJsonFile(source.file);
      return loadGeoJsonUrl(source.url);
    }
    throw new Error("Unsupported layer type: " + type);
  }

  async function addLayerFromConfig(cfg) {
    const map = State.getMap();
    if (!map) throw new Error("Map not ready");

    const id = State.nextId(cfg.type || "layer");
    const isTimeSeries = Array.isArray(cfg.times) && cfg.times.length > 0;

    const entry = {
      id,
      name: cfg.name || "Untitled layer",
      type: cfg.type,
      visible: cfg.visible !== false,
      opacity: cfg.opacity != null ? cfg.opacity : 1,
      style: cfg.style || null,
      source: cfg.source || null,
      times: isTimeSeries ? cfg.times.slice() : null,
      timeIndex: isTimeSeries ? 0 : null,
      timeCache: isTimeSeries ? new Map() : null,
      sourceId: null,
      layerId: null,
      loading: true,
      error: null,
      sourceDesc: describeSource(cfg),
    };

    State.addLayer(entry);

    try {
      const source = isTimeSeries
        ? { kind: "url", url: cfg.times[0].url }
        : cfg.source;
      const data = await loadLayerData(cfg.type, source, cfg.style);
      
      const srcId = sourceId(id, "source");
      const lyrId = sourceId(id, "layer");
      entry.sourceId = srcId;
      entry.layerId = lyrId;
      
      if (cfg.type === "cog") {
        map.addSource(srcId, {
          type: "image",
          url: data.dataUrl,
          coordinates: data.coordinates,
        });
        map.addLayer({
          id: lyrId,
          type: "raster",
          source: srcId,
          paint: {
            "raster-opacity": entry.opacity,
          },
        });
        entry.__bounds = data.bounds;
      } else if (cfg.type === "geojson") {
        map.addSource(srcId, {
          type: "geojson",
          data: data,
        });
        map.addLayer({
          id: lyrId,
          type: "fill",
          source: srcId,
          paint: {
            "fill-color": "#6ab048",
            "fill-opacity": 0.18 * entry.opacity,
          },
        });
        map.addLayer({
          id: lyrId + "_line",
          type: "line",
          source: srcId,
          paint: {
            "line-color": "#6ab048",
            "line-width": 2,
            "line-opacity": entry.opacity,
          },
        });
        map.addLayer({
          id: lyrId + "_circle",
          type: "circle",
          source: srcId,
          paint: {
            "circle-color": "#6ab048",
            "circle-radius": 5,
            "circle-opacity": 0.6 * entry.opacity,
          },
        });
        const bounds = map.getSource(srcId).bounds;
        entry.__bounds = bounds;
      }
      
      if (isTimeSeries) entry.timeCache.set(0, data);
      
      if (!entry.visible) {
        map.setLayoutProperty(lyrId, "visibility", "none");
        if (cfg.type === "geojson") {
          map.setLayoutProperty(lyrId + "_line", "visibility", "none");
          map.setLayoutProperty(lyrId + "_circle", "visibility", "none");
        }
      }

      if (entry.__bounds) {
        const otherLayers = State.getLayers().filter((l) => l.id !== id);
        if (otherLayers.length === 0) {
          map.fitBounds(entry.__bounds, { padding: 40, maxZoom: 12 });
        }
      }
      
      // Ensure basemap stays at bottom
      if (map.getLayer("basemap")) {
        const allLayers = map.getStyle().layers;
        const firstNonBase = allLayers.find((l) => l.id !== "basemap");
        if (firstNonBase) map.moveLayer("basemap", firstNonBase.id);
      }
    } catch (err) {
      console.error("Failed to load layer", entry.name, err);
      entry.error = err.message || String(err);
    } finally {
      entry.loading = false;
      State.updateLayer(id, {});
      State.reconcileActiveTimeLayer();
    }

    return entry;
  }

  function describeSource(cfg) {
    if (Array.isArray(cfg.times) && cfg.times.length) {
      return cfg.times.length + " timesteps";
    }
    if (cfg.source) {
      if (cfg.source.kind === "file") return "file: " + (cfg.source.file?.name || "uploaded");
      if (cfg.source.url) return cfg.source.url;
    }
    return "";
  }

  function setLayerVisible(layer, visible) {
    const map = State.getMap();
    if (!layer.layerId) {
      State.updateLayer(layer.id, { visible });
      State.reconcileActiveTimeLayer();
      return;
    }
    const visibility = visible ? "visible" : "none";
    map.setLayoutProperty(layer.layerId, "visibility", visibility);
    if (layer.type === "geojson") {
      map.setLayoutProperty(layer.layerId + "_line", visibility);
      map.setLayoutProperty(layer.layerId + "_circle", visibility);
    }
    State.updateLayer(layer.id, { visible });
    State.reconcileActiveTimeLayer();
  }

  function setLayerOpacity(layer, opacity) {
    layer.opacity = opacity;
    const map = State.getMap();
    if (layer.layerId) {
      if (layer.type === "cog" || layer.type === "d2s-raster") {
        map.setPaintProperty(layer.layerId, "raster-opacity", opacity);
      } else if (layer.type === "geojson") {
        map.setPaintProperty(layer.layerId, "fill-opacity", 0.18 * opacity);
        map.setPaintProperty(layer.layerId + "_line", "line-opacity", opacity);
        map.setPaintProperty(layer.layerId + "_circle", "circle-opacity", 0.6 * opacity);
      }
    }
    State.updateLayer(layer.id, { opacity });
  }

  async function setLayerTimeIndex(layer, idx) {
    if (!layer || !layer.times) return;
    if (idx === layer.timeIndex) return;
    if (idx < 0 || idx >= layer.times.length) return;

    const map = State.getMap();
    const time = layer.times[idx];

    let data = layer.timeCache.get(idx);
    if (!data) {
      State.updateLayer(layer.id, { timeLoading: true });
      try {
        data = await loadLayerData(
          layer.type,
          { kind: "url", url: time.url },
          layer.style
        );
        layer.timeCache.set(idx, data);
      } catch (err) {
        console.error("Failed to load timestep", time, err);
        State.updateLayer(layer.id, {
          timeLoading: false,
          error: "Timestep " + time.label + ": " + (err.message || err),
        });
        return;
      }
      State.updateLayer(layer.id, { timeLoading: false, error: null });
    }

    const srcId = layer.sourceId;
    if (layer.type === "cog") {
      map.removeSource(srcId);
      map.addSource(srcId, {
        type: "image",
        url: data.dataUrl,
        coordinates: data.coordinates,
      });
    } else if (layer.type === "geojson") {
      map.getSource(srcId).setData(data);
    }

    // Ensure basemap stays at bottom after source update
    if (map.getLayer("basemap")) {
      const allLayers = map.getStyle().layers;
      const firstNonBase = allLayers.find((l) => l.id !== "basemap");
      if (firstNonBase) map.moveLayer("basemap", firstNonBase.id);
    }

    layer.timeIndex = idx;
    State.updateLayer(layer.id, {});
  }

  function removeLayer(layer) {
    const map = State.getMap();
    if (layer.layerId) {
      if (map.getLayer(layer.layerId)) map.removeLayer(layer.layerId);
      if (layer.type === "geojson") {
        if (map.getLayer(layer.layerId + "_line")) map.removeLayer(layer.layerId + "_line");
        if (map.getLayer(layer.layerId + "_circle")) map.removeLayer(layer.layerId + "_circle");
      }
    }
    if (layer.sourceId && map.getSource(layer.sourceId)) {
      map.removeSource(layer.sourceId);
    }
    if (layer.timeCache) layer.timeCache.clear();
    State.removeLayer(layer.id);
    State.reconcileActiveTimeLayer();
  }

  async function addD2STileLayer(cfg) {
    const map = State.getMap();
    if (!map) throw new Error("Map not ready");

    const id = State.nextId("d2s-tile");

    const entry = {
      id,
      name: cfg.name || "D2S Tile Layer",
      type: "d2s-raster",
      visible: cfg.visible !== false,
      opacity: cfg.opacity != null ? cfg.opacity : 1,
      sourceId: null,
      layerId: null,
      loading: true,
      error: null,
      sourceDesc: cfg.sourceDesc || "D2S TiTiler",
    };

    State.addLayer(entry);

    try {
      const srcId = sourceId(id, "source");
      const lyrId = sourceId(id, "layer");
      entry.sourceId = srcId;
      entry.layerId = lyrId;

      // Add MapLibre raster tile source
      map.addSource(srcId, {
        type: "raster",
        tiles: [cfg.tileUrl],
        tileSize: 256,
        bounds: cfg.bounds, // [minx, miny, maxx, maxy]
      });

      map.addLayer({
        id: lyrId,
        type: "raster",
        source: srcId,
        paint: {
          "raster-opacity": entry.opacity,
        },
      });

      if (!entry.visible) {
        map.setLayoutProperty(lyrId, "visibility", "none");
      }

      // Store bounds for zoom-to-layer
      if (cfg.bounds && cfg.bounds.length === 4) {
        entry.__bounds = cfg.bounds;
      }

      // Ensure basemap stays at bottom
      if (map.getLayer("basemap")) {
        const allLayers = map.getStyle().layers;
        const firstNonBase = allLayers.find((l) => l.id !== "basemap");
        if (firstNonBase) map.moveLayer("basemap", firstNonBase.id);
      }

      // Fit to bounds if first layer
      if (entry.__bounds) {
        const otherLayers = State.getLayers().filter((l) => l.id !== id);
        if (otherLayers.length === 0) {
          map.fitBounds(entry.__bounds, { padding: 40, maxZoom: 12 });
        }
      }
    } catch (err) {
      console.error("Failed to load D2S tile layer", entry.name, err);
      entry.error = err.message || String(err);
    } finally {
      entry.loading = false;
      State.updateLayer(id, {});
    }

    return entry;
  }

  window.Layers = {
    detectType,
    addLayerFromConfig,
    addD2STileLayer,
    setLayerVisible,
    setLayerOpacity,
    setLayerTimeIndex,
    removeLayer,
  };
})();
