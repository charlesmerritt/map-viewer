#!/usr/bin/env node
/* ----------------------------------------------------------------
   db-migrate.mjs — apply db/migrations/*.sql in filename order.

   Run against the Railway PostGIS service:

     railway run --service map-viewer pnpm db:migrate

   Requires DATABASE_URL (superuser, to create extensions and roles) and
   TILESERV_PASSWORD (the password the pg_tileserv service authenticates
   with). Applied files are recorded in vector.schema_migrations, so
   re-running is a no-op.
   ---------------------------------------------------------------- */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closePool, getPool, isConfigured } from "../db/client.mjs";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

// The tile server role is created before the first migration runs, because
// 001 grants to it. Password comes from the environment so it never lands in
// a file that gets committed.
async function ensureTileservRole(client) {
  const password = process.env.TILESERV_PASSWORD;
  if (!password) {
    throw new Error(
      "TILESERV_PASSWORD is not set — it must match the password in the " +
        "pg-tileserv service's DATABASE_URL."
    );
  }

  // CREATE/ALTER ROLE cannot take a bind parameter for the password, and a
  // DO block cannot take one at all, so let Postgres escape the literal for
  // us rather than hand-rolling it.
  const { rows } = await client.query(`SELECT quote_literal($1) AS literal`, [
    password,
  ]);
  const literal = rows[0].literal;

  const { rowCount } = await client.query(
    `SELECT 1 FROM pg_roles WHERE rolname = 'tileserv'`
  );
  const verb = rowCount > 0 ? "ALTER" : "CREATE";
  await client.query(`${verb} ROLE tileserv LOGIN PASSWORD ${literal}`);
  console.log(`${verb === "CREATE" ? "created" : "updated"} role tileserv`);
}

async function appliedMigrations(client) {
  const { rows } = await client.query(
    `SELECT filename FROM vector.schema_migrations`
  );
  return new Set(rows.map((row) => row.filename));
}

async function main() {
  // A deployment without vector layers is a supported configuration, not a
  // failure — boot.mjs chains this before the server, so exiting non-zero here
  // would take the whole app down over an optional feature.
  if (!isConfigured()) {
    console.log("DATABASE_URL is not set — skipping vector migrations.");
    return;
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migrations found.");
    return;
  }

  const client = await getPool().connect();
  try {
    await ensureTileservRole(client);

    // schema_migrations lives inside the first migration, so the first run
    // has nothing to read. Treat a missing table as "nothing applied yet".
    let applied = new Set();
    try {
      applied = await appliedMigrations(client);
    } catch (error) {
      if (error.code !== "42P01") throw error; // undefined_table
    }

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`skip  ${filename} (already applied)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      console.log(`apply ${filename}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO vector.schema_migrations (filename) VALUES ($1)
           ON CONFLICT (filename) DO NOTHING`,
          [filename]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${filename} failed: ${error.message}`);
      }
    }
    console.log("Migrations up to date.");
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
  closePool().catch(() => {});
});
