#!/usr/bin/env node
/* ----------------------------------------------------------------
   boot.mjs — production entrypoint.

   Applies vector migrations, then starts the server. pg_tileserv cannot
   authenticate until migration 001 has created its role, so running this
   on every deploy is what makes the tile service come up on its own
   rather than needing a manual step in a particular order.

   A migration failure is logged loudly but does NOT stop the server: the
   map, the basemaps and every raster path work without a database, and
   the vector endpoints already degrade to "not configured". Losing the
   whole viewer because an optional subsystem failed would be worse.
   ---------------------------------------------------------------- */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRasterServer, loadDotEnv } from "../server.mjs";

// Load .env before migrating so a local `pnpm start` sees DATABASE_URL the
// same way `pnpm dev` does. The child process inherits the result.
loadDotEnv();

function run(scriptUrl) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(scriptUrl, import.meta.url))],
      { stdio: "inherit" }
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const migrateCode = await run("./db-migrate.mjs");
if (migrateCode !== 0) {
  console.error(
    "[boot] Vector migrations failed. Starting the server anyway — raster " +
      "layers will work and vector layers will report as unconfigured."
  );
}

const port = Number(process.env.PORT || 3000);
createRasterServer().listen(port, () => {
  console.log(`PERSEUS Map Viewer listening on http://localhost:${port}`);
});
