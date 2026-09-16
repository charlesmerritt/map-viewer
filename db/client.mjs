/* ----------------------------------------------------------------
   db/client.mjs — lazily-created PostGIS connection pool.

   The viewer runs fine with no database: every vector endpoint checks
   isConfigured() first and answers 503 rather than throwing, so local
   development and the existing server tests work unchanged without a
   DATABASE_URL in the environment.
   ---------------------------------------------------------------- */

import pg from "pg";

let pool = null;

export function databaseUrl() {
  return process.env.DATABASE_URL || "";
}

export function isConfigured() {
  return Boolean(databaseUrl());
}

export function getPool() {
  if (!isConfigured()) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.PGPOOL_MAX || 4),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Railway's PostGIS template serves a self-signed (snakeoil)
      // certificate, so verification would fail against it. The connection
      // still runs over Railway's private network.
      ssl: /\bsslmode=(require|prefer)\b/.test(databaseUrl())
        ? { rejectUnauthorized: false }
        : false,
    });
    pool.on("error", (error) => {
      console.error("[db] idle client error", error);
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
