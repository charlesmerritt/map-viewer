#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
// Vector uploads are parsed into memory before they reach PostGIS, so they get
// a much smaller ceiling than the streamed-to-disk raster path.
const DEFAULT_MAX_VECTOR_BYTES = 128 * 1024 * 1024;
const TIFF_EXTENSIONS = new Set([".tif", ".tiff"]);
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

class UploadTooLargeError extends Error {}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function rasterPath(uploadDir, id, extension) {
  return join(uploadDir, `${id}${extension}`);
}

function isTiffSignature(bytes) {
  if (bytes.length < 4) return false;
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
  const version = littleEndian
    ? bytes[2] | (bytes[3] << 8)
    : (bytes[2] << 8) | bytes[3];
  return (littleEndian || bigEndian) && (version === 42 || version === 43);
}

function uploadMeter(maxBytes) {
  let size = 0;
  let signature = Buffer.alloc(0);
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new UploadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
        return;
      }
      if (signature.length < 4) {
        signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
      }
      callback(null, chunk);
    },
  });
  return {
    stream,
    get size() { return size; },
    get signature() { return signature; },
  };
}

function publicOrigin(req, configuredOrigin) {
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, "");
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string"
    ? forwardedProto.split(",")[0].trim()
    : "http";
  return `${protocol}://${req.headers.host}`;
}

async function receiveRaster(req, res, url, options) {
  const originalName = basename(url.searchParams.get("name") || "");
  const extension = extname(originalName).toLowerCase();
  if (!originalName || !TIFF_EXTENSIONS.has(extension)) {
    json(res, 415, { error: "Only .tif and .tiff uploads are supported." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > options.maxUploadBytes) {
    json(res, 413, { error: `Upload exceeds ${options.maxUploadBytes} bytes.` });
    return;
  }

  await mkdir(options.uploadDir, { recursive: true });
  const id = randomUUID();
  const destination = rasterPath(options.uploadDir, id, extension);
  const meter = uploadMeter(options.maxUploadBytes);

  try {
    await pipeline(req, meter.stream, createWriteStream(destination, { flags: "wx" }));
    if (!isTiffSignature(meter.signature)) {
      await rm(destination, { force: true });
      json(res, 415, { error: "The uploaded file is not a TIFF." });
      return;
    }
  } catch (error) {
    await rm(destination, { force: true });
    if (error instanceof UploadTooLargeError) {
      json(res, 413, { error: error.message });
      return;
    }
    throw error;
  }

  const encodedName = encodeURIComponent(originalName);
  const path = `/api/rasters/${id}/${encodedName}`;
  json(res, 201, {
    id,
    name: originalName,
    size: meter.size,
    url: `${publicOrigin(req, options.publicBaseUrl)}${path}`,
    deleteUrl: `/api/rasters/${id}`,
  });
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!suffixLength) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

async function serveRaster(req, res, id, encodedName, options) {
  const name = decodeURIComponent(encodedName);
  const extension = extname(name).toLowerCase();
  if (!TIFF_EXTENSIONS.has(extension)) {
    json(res, 404, { error: "Raster not found." });
    return;
  }

  const path = rasterPath(options.uploadDir, id, extension);
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      json(res, 404, { error: "Raster not found." });
      return;
    }
    throw error;
  }

  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "image/tiff",
    "x-content-type-options": "nosniff",
  };
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, file.size);
    if (!range) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${file.size}` });
      res.end();
      return;
    }
    const contentLength = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      "content-length": contentLength,
      "content-range": `bytes ${range.start}-${range.end}/${file.size}`,
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(path, range).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": file.size });
  if (req.method === "HEAD") res.end();
  else createReadStream(path).pipe(res);
}

async function deleteRaster(res, id, options) {
  const results = await Promise.all(
    [...TIFF_EXTENSIONS].map((extension) =>
      rm(rasterPath(options.uploadDir, id, extension), { force: true })
    )
  );
  void results;
  res.writeHead(204);
  res.end();
}

// ---- Vector layers (PostGIS + pg_tileserv) ----

// The vector endpoints load db/* lazily so that a deployment without a
// DATABASE_URL — or without `pg` installed — still serves the map and the
// raster paths instead of failing at import time.
async function vectorModules() {
  const [client, registry, ingest] = await Promise.all([
    import("./db/client.mjs"),
    import("./db/registry.mjs"),
    import("./db/ingest.mjs"),
  ]);
  return { client, registry, ingest };
}

function vectorUnavailable(res) {
  json(res, 503, {
    error:
      "Vector layers are not configured. Set DATABASE_URL and VECTOR_TILE_BASE_URL.",
  });
}

async function listVectorLayers(res, options) {
  const { client, registry } = await vectorModules();
  if (!client.isConfigured()) {
    // Not an error: a viewer with no database simply has no vector catalog.
    json(res, 200, { layers: [], configured: false });
    return;
  }
  const layers = await registry.listLayers(options.vectorTileBaseUrl);
  json(res, 200, {
    layers,
    configured: true,
    tileBaseUrl: options.vectorTileBaseUrl,
  });
}

async function serveVectorLayerBounds(res, tableName, options) {
  const { client, registry } = await vectorModules();
  if (!client.isConfigured()) {
    vectorUnavailable(res);
    return;
  }
  let bounds;
  try {
    bounds = await registry.layerBounds(tableName);
  } catch (error) {
    json(res, 400, { error: error.message });
    return;
  }
  if (!bounds) {
    json(res, 404, { error: "Layer not found or empty." });
    return;
  }
  json(res, 200, { bounds });
}

async function serveVectorFeature(res, tableName, featureId, options) {
  const { client, registry } = await vectorModules();
  if (!client.isConfigured()) {
    vectorUnavailable(res);
    return;
  }
  const entry = await registry.getLayer(tableName, options.vectorTileBaseUrl);
  if (!entry) {
    json(res, 404, { error: "Layer not found." });
    return;
  }
  if (!entry.idColumn) {
    json(res, 409, { error: "Layer has no id column registered." });
    return;
  }
  let feature;
  try {
    feature = await registry.getFeature(tableName, entry.idColumn, featureId);
  } catch (error) {
    json(res, 400, { error: error.message });
    return;
  }
  if (!feature) {
    json(res, 404, { error: "Feature not found." });
    return;
  }
  json(res, 200, feature);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new UploadTooLargeError(`Upload exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function receiveVector(req, res, url, options) {
  const { client, ingest } = await vectorModules();
  if (!client.isConfigured()) {
    vectorUnavailable(res);
    return;
  }

  const name = basename(url.searchParams.get("name") || "").trim();
  if (!name) {
    json(res, 400, { error: "A ?name= parameter is required." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > options.maxVectorBytes) {
    json(res, 413, { error: `Upload exceeds ${options.maxVectorBytes} bytes.` });
    return;
  }

  let collection;
  try {
    collection = await readJsonBody(req, options.maxVectorBytes);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      json(res, 413, { error: error.message });
      return;
    }
    json(res, 400, { error: "Body is not valid JSON." });
    return;
  }

  try {
    const result = await ingest.ingestGeoJson(collection, {
      title: name,
      description: url.searchParams.get("description") || null,
    });
    json(res, 201, {
      ...result,
      tileUrl:
        `${options.vectorTileBaseUrl.replace(/\/$/, "")}` +
        `/vector.${result.tableName}/{z}/{x}/{y}.pbf`,
      deleteUrl: `/api/vector/layers/${result.tableName}`,
    });
  } catch (error) {
    console.error("[vector] ingest failed", error);
    json(res, 422, { error: error.message || "Could not ingest GeoJSON." });
  }
}

async function deleteVectorLayer(res, tableName) {
  const { client, ingest } = await vectorModules();
  if (!client.isConfigured()) {
    vectorUnavailable(res);
    return;
  }
  try {
    const removed = await ingest.dropLayer(tableName);
    if (!removed) {
      json(res, 404, { error: "Layer not found." });
      return;
    }
    res.writeHead(204);
    res.end();
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}

async function serveStatic(req, res, url, publicDir) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "Method not allowed." });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    json(res, 400, { error: "Invalid URL path." });
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let path = resolve(publicDir, relativePath);
  if (path !== publicDir && !path.startsWith(publicDir + sep)) {
    json(res, 404, { error: "Not found." });
    return;
  }

  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (extname(relativePath)) {
      json(res, 404, { error: "Not found." });
      return;
    }
    path = join(publicDir, "index.html");
    file = await stat(path);
  }

  if (!file.isFile()) {
    json(res, 404, { error: "Not found." });
    return;
  }
  res.writeHead(200, {
    "content-length": file.size,
    "content-type": MIME_TYPES.get(extname(path).toLowerCase()) || "application/octet-stream",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(path).pipe(res);
}

export function createRasterServer(overrides = {}) {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const options = {
    publicDir: resolve(overrides.publicDir || join(root, "public")),
    uploadDir: resolve(overrides.uploadDir || process.env.UPLOAD_DIR || join(root, ".uploads")),
    publicBaseUrl: overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "",
    maxUploadBytes: Number(
      overrides.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES
    ),
    maxVectorBytes: Number(
      overrides.maxVectorBytes ?? process.env.MAX_VECTOR_BYTES ?? DEFAULT_MAX_VECTOR_BYTES
    ),
    vectorTileBaseUrl: (
      overrides.vectorTileBaseUrl ??
      process.env.VECTOR_TILE_BASE_URL ??
      ""
    ).replace(/\/$/, ""),
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "POST" && url.pathname === "/api/rasters") {
        await receiveRaster(req, res, url, options);
        return;
      }

      const rasterMatch = /^\/api\/rasters\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname);
      if ((req.method === "GET" || req.method === "HEAD") && rasterMatch) {
        await serveRaster(req, res, rasterMatch[1], rasterMatch[2], options);
        return;
      }

      const deleteMatch = /^\/api\/rasters\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === "DELETE" && deleteMatch) {
        await deleteRaster(res, deleteMatch[1], options);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/vector/layers") {
        await listVectorLayers(res, options);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/vector/layers") {
        await receiveVector(req, res, url, options);
        return;
      }

      const vectorBoundsMatch = /^\/api\/vector\/layers\/([a-z_][a-z0-9_]*)\/bounds$/.exec(
        url.pathname
      );
      if (req.method === "GET" && vectorBoundsMatch) {
        await serveVectorLayerBounds(res, vectorBoundsMatch[1], options);
        return;
      }

      const vectorFeatureMatch =
        /^\/api\/vector\/layers\/([a-z_][a-z0-9_]*)\/features\/([^/]+)$/.exec(
          url.pathname
        );
      if (req.method === "GET" && vectorFeatureMatch) {
        await serveVectorFeature(
          res,
          vectorFeatureMatch[1],
          decodeURIComponent(vectorFeatureMatch[2]),
          options
        );
        return;
      }

      const vectorDeleteMatch = /^\/api\/vector\/layers\/([a-z_][a-z0-9_]*)$/.exec(
        url.pathname
      );
      if (req.method === "DELETE" && vectorDeleteMatch) {
        await deleteVectorLayer(res, vectorDeleteMatch[1]);
        return;
      }

      if (req.method === "GET" && url.pathname === "/env.js") {
        const body = `window.__ENV = { CARTO_API_KEY: ${JSON.stringify(
          process.env.CARTO_API_KEY || ""
        )}, VECTOR_TILE_BASE_URL: ${JSON.stringify(
          options.vectorTileBaseUrl
        )} };\n`;
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        json(res, 404, { error: "API endpoint not found." });
        return;
      }
      await serveStatic(req, res, url, options.publicDir);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "Internal server error." });
      else res.destroy(error);
    }
  });
}

// Exported so scripts/boot.mjs gets the same local-development .env handling
// before it runs migrations; on Railway the platform supplies the variables
// and there is no .env to read.
export function loadDotEnv() {
  const envPath = join(fileURLToPath(new URL(".", import.meta.url)), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  const port = Number(process.env.PORT || 3000);
  createRasterServer().listen(port, () => {
    console.log(`PERSEUS Map Viewer listening on http://localhost:${port}`);
  });
}
