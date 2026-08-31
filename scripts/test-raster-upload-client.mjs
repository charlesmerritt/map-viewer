#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RasterUploads = require("../public/raster-upload.js");
const file = { name: "biomass 2030.tif", type: "image/tiff", size: 123 };
let request;

const uploaded = await RasterUploads.upload(file, async (url, options) => {
  request = { url, options };
  return new Response(JSON.stringify({
    url: "https://viewer.example/api/rasters/id/biomass%202030.tif",
    deleteUrl: "/api/rasters/id",
    size: 123,
  }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
});

assert.equal(request.url, "/api/rasters?name=biomass%202030.tif");
assert.equal(request.options.method, "POST");
assert.equal(request.options.body, file, "File is streamed as the request body");
assert.equal(request.options.headers["content-type"], "image/tiff");
assert.equal(uploaded.size, 123);

await assert.rejects(
  RasterUploads.upload(
    { ...file, name: "plain.tif" },
    async () => new Response(JSON.stringify({ error: "The configured TiTiler could not open this COG." }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })
  ),
  /could not open this COG/
);

assert.equal(RasterUploads.isRasterFile("forest.TIFF"), true);
assert.equal(RasterUploads.isRasterFile("forest.geojson"), false);

console.log("Raster upload client is valid.");
