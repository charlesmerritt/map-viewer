#!/usr/bin/env node
/* ----------------------------------------------------------------
   db-load-boundaries.mjs — load public/data/*.geojson into PostGIS.

     railway run --service map-viewer pnpm db:load-boundaries

   Idempotent: each table is truncated and reloaded, then registered in
   vector.layer_registry so the viewer's catalog picks it up. Run
   `pnpm db:migrate` first — this script assumes the tables exist.
   ---------------------------------------------------------------- */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { closePool, getPool, isConfigured } from "../db/client.mjs";
import { registerLayer } from "../db/registry.mjs";

const DATA_DIR = fileURLToPath(new URL("../public/data", import.meta.url));

const DATASETS = [
  {
    file: "us-states.geojson",
    table: "us_states",
    columns: ["statefp", "stusps", "name"],
    registry: {
      title: "US states",
      description: "Census cartographic boundary states (1:5,000,000, GENZ2022).",
      geometryType: "Polygon",
      idColumn: "statefp",
      labelColumn: "name",
      attributes: ["statefp", "stusps", "name"],
      defaultStyle: { color: "#6ab048", fillOpacity: 0.12, lineWidth: 1.5 },
      minZoom: 0,
      maxZoom: 22,
      isBuiltin: true,
    },
  },
  {
    file: "us-counties.geojson",
    table: "us_counties",
    columns: ["geoid", "statefp", "stusps", "name"],
    registry: {
      title: "US counties",
      description: "Census cartographic boundary counties (1:5,000,000, GENZ2022).",
      geometryType: "Polygon",
      idColumn: "geoid",
      labelColumn: "name",
      attributes: ["geoid", "statefp", "stusps", "name"],
      defaultStyle: { color: "#4a9fd8", fillOpacity: 0.08, lineWidth: 0.8 },
      // Counties are dense enough that drawing them under z4 is noise.
      minZoom: 4,
      maxZoom: 22,
      isBuiltin: true,
    },
  },
];

// Insert in batches so a 3,235-feature county load doesn't build one enormous
// statement, and so a bad feature names the batch it came from.
const BATCH_SIZE = 250;

async function loadDataset(client, dataset) {
  const raw = await readFile(`${DATA_DIR}/${dataset.file}`, "utf8");
  const collection = JSON.parse(raw);
  const features = collection.features || [];
  if (features.length === 0) {
    throw new Error(`${dataset.file} contains no features`);
  }

  await client.query(`TRUNCATE vector.${dataset.table}`);

  const columnList = dataset.columns.join(", ");
  let inserted = 0;

  for (let start = 0; start < features.length; start += BATCH_SIZE) {
    const batch = features.slice(start, start + BATCH_SIZE);
    const values = [];
    const tuples = [];

    batch.forEach((feature) => {
      const base = values.length;
      dataset.columns.forEach((column) => {
        values.push(feature.properties?.[column] ?? null);
      });
      values.push(JSON.stringify(feature.geometry));
      const columnPlaceholders = dataset.columns.map((_, i) => `$${base + i + 1}`);
      const geomPlaceholder = `$${base + dataset.columns.length + 1}`;
      // ST_Multi normalises the mixed Polygon/MultiPolygon input the Census
      // files contain into the MultiPolygon column type.
      tuples.push(
        `(${columnPlaceholders.join(", ")}, ` +
          `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geomPlaceholder}), 4326)))`
      );
    });

    const result = await client.query(
      `INSERT INTO vector.${dataset.table} (${columnList}, geom)
       VALUES ${tuples.join(", ")}`,
      values
    );
    inserted += result.rowCount;
  }

  return inserted;
}

async function main() {
  if (!isConfigured()) {
    console.error("DATABASE_URL is not set. Nothing to load.");
    process.exitCode = 1;
    return;
  }

  const client = await getPool().connect();
  try {
    for (const dataset of DATASETS) {
      await client.query("BEGIN");
      try {
        const count = await loadDataset(client, dataset);
        await registerLayer(client, dataset.table, dataset.registry);
        await client.query("COMMIT");
        console.log(`loaded ${count} features into vector.${dataset.table}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${dataset.file}: ${error.message}`);
      }
    }
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
