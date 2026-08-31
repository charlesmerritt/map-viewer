#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRasterServer } from "../server.mjs";
import { request as httpRequest } from "node:http";

const uploadDir = await mkdtemp(join(tmpdir(), "map-viewer-uploads-"));
const server = createRasterServer({
  uploadDir,
  publicDir: join(process.cwd(), "public"),
  publicBaseUrl: "https://viewer.example",
  maxUploadBytes: 32,
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const tiff = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x43, 0x4f, 0x47, 0x2d, 0x44, 0x41, 0x54, 0x41,
  ]);

  const upload = await fetch(`${baseUrl}/api/rasters?name=biomass.tif`, {
    method: "POST",
    headers: { "content-type": "image/tiff" },
    body: tiff,
  });
  assert.equal(upload.status, 201, "valid TIFF upload is accepted");
  const uploaded = await upload.json();
  assert.match(
    uploaded.url,
    /^https:\/\/viewer\.example\/api\/rasters\/[0-9a-f-]+\/biomass\.tif$/,
    "upload returns a public TiTiler-readable URL"
  );
  assert.equal(uploaded.size, tiff.length);

  const uploadedPath = new URL(uploaded.url).pathname;
  const range = await fetch(`${baseUrl}${uploadedPath}`, {
    headers: { Range: "bytes=4-7" },
  });
  assert.equal(range.status, 206, "uploaded rasters support byte ranges");
  assert.equal(range.headers.get("accept-ranges"), "bytes");
  assert.equal(range.headers.get("content-range"), `bytes 4-7/${tiff.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), tiff.subarray(4, 8));

  const head = await fetch(`${baseUrl}${uploadedPath}`, { method: "HEAD" });
  assert.equal(head.status, 200, "uploaded rasters support HEAD requests");
  assert.equal(head.headers.get("content-length"), String(tiff.length));
  assert.equal(head.headers.get("content-type"), "image/tiff");
  assert.equal(
    head.headers.get("x-content-type-options"),
    "nosniff",
    "served rasters forbid MIME sniffing"
  );

  const escapeAttempt = await fetch(
    `${baseUrl}/api/rasters/${uploaded.id}/..%2f..%2fserver.mjs`
  );
  assert.equal(
    escapeAttempt.status,
    404,
    "path traversal in the raster name is rejected"
  );

  const invalidRange = await fetch(`${baseUrl}${uploadedPath}`, {
    headers: { Range: "bytes=99-100" },
  });
  assert.equal(invalidRange.status, 416, "invalid ranges are rejected");
  assert.equal(invalidRange.headers.get("content-range"), `bytes */${tiff.length}`);

  const badExtension = await fetch(`${baseUrl}/api/rasters?name=notes.txt`, {
    method: "POST",
    body: tiff,
  });
  assert.equal(badExtension.status, 415, "non-TIFF extensions are rejected");

  const badMagic = await fetch(`${baseUrl}/api/rasters?name=fake.tif`, {
    method: "POST",
    body: Buffer.from("not a tiff"),
  });
  assert.equal(badMagic.status, 415, "non-TIFF content is rejected");

  const oversized = await fetch(`${baseUrl}/api/rasters?name=huge.tif`, {
    method: "POST",
    headers: { "content-length": "33" },
    body: Buffer.alloc(33),
  });
  assert.equal(oversized.status, 413, "configured upload size limit is enforced");

  const traversalName = await fetch(
    `${baseUrl}/api/rasters?name=${encodeURIComponent("../../etc/passwd.tif")}`,
    { method: "POST", body: tiff }
  );
  assert.equal(
    traversalName.status,
    201,
    "traversal-style names are accepted but never reach the filesystem"
  );
  const traversalUpload = await traversalName.json();
  assert.match(
    new URL(traversalUpload.url).pathname,
    /^\/api\/rasters\/[0-9a-f-]{36}\/passwd\.tif$/,
    "storage path is a bare UUID, not the client-supplied name"
  );

  const crlfName = await fetch(
    `${baseUrl}/api/rasters?name=${encodeURIComponent("a.tif\r\nX-Injected: 1")}`,
    { method: "POST", body: tiff }
  );
  assert.equal(crlfName.status, 415, "CRLF-bearing names are rejected");

  const streamedOversize = await new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}/api/rasters?name=chunked.tif`, {
      method: "POST",
      headers: { "transfer-encoding": "chunked" },
    }, resolve);
    req.on("error", reject);
    req.write(Buffer.alloc(20));
    req.write(Buffer.alloc(20));
    req.end();
  });
  streamedOversize.resume();
  assert.equal(
    streamedOversize.statusCode,
    413,
    "size cap is enforced while streaming without content-length"
  );

  const removed = await fetch(`${baseUrl}${uploaded.deleteUrl}`, { method: "DELETE" });
  assert.equal(removed.status, 204, "temporary raster can be deleted");
  assert.equal((await fetch(`${baseUrl}${uploadedPath}`)).status, 404);

  const removedTraversal = await fetch(
    `${baseUrl}${traversalUpload.deleteUrl}`,
    { method: "DELETE" }
  );
  assert.equal(removedTraversal.status, 204, "traversal-named raster can be deleted");

  assert.deepEqual(
    await readdir(uploadDir),
    [],
    "rejected, aborted, and deleted uploads leave no files behind"
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await rm(uploadDir, { recursive: true, force: true });
}

console.log("Raster upload server is valid.");
