#!/usr/bin/env node
// Runs the real app server (server.mjs) and logs every /api/rasters request
// as one JSON line: method, Range header, status, bytes sent. Used to compare
// TiTiler's range-request pattern with the 2026-11-05 production logs.
//
//   PORT=3311 UPLOAD_DIR=... PUBLIC_BASE_URL=http://127.0.0.1:3311 \
//   RANGE_LOG=.../ranges.jsonl node notes/basal-area-render/logged-server.mjs
import { appendFileSync } from "node:fs";
import { createRasterServer } from "../../server.mjs";

const logPath = process.env.RANGE_LOG;
const server = createRasterServer();
const handlers = server.listeners("request");
server.removeAllListeners("request");
server.on("request", (req, res) => {
  if (logPath && req.url.startsWith("/api/rasters")) {
    let bytes = 0;
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk) bytes += chunk.length;
      return write(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== "function") bytes += chunk.length;
      return end(chunk, ...rest);
    };
    res.on("finish", () => {
      appendFileSync(
        logPath,
        JSON.stringify({
          t: Date.now(),
          method: req.method,
          path: req.url.replace(/^\/api\/rasters\/[0-9a-f-]{36}\//, ""),
          range: req.headers.range || null,
          status: res.statusCode,
          bytes,
          ua: req.headers["user-agent"] || null,
        }) + "\n"
      );
    });
  }
  for (const handler of handlers) handler.call(server, req, res);
});
const port = Number(process.env.PORT || 3311);
server.listen(port, "127.0.0.1", () => {
  console.log(`logged app server on http://127.0.0.1:${port}`);
});
