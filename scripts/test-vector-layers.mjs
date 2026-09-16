#!/usr/bin/env node
/* Unit tests for the vector-layer pieces that do not need a database:
   catalog shaping, table-name derivation, GeoJSON validation, and the
   server's behaviour when no DATABASE_URL is configured. */

import assert from "node:assert/strict";
import { join } from "node:path";

import { createRasterServer } from "../server.mjs";
import { assertSafeTableName, toCatalogEntry } from "../db/registry.mjs";
import {
  buildViewSql,
  collectAttributes,
  paintFamily,
  sourceTableFor,
  styleableAttributes,
  tableNameFor,
  validateCollection,
} from "../db/ingest.mjs";

// ---- toCatalogEntry ----

const entry = toCatalogEntry(
  {
    table_name: "us_counties",
    title: "US counties",
    description: "Census counties",
    geometry_type: "Polygon",
    id_column: "geoid",
    label_column: "name",
    attributes: ["geoid", "name"],
    default_style: { color: "#4a9fd8" },
    min_zoom: 4,
    max_zoom: 22,
    is_builtin: true,
  },
  "https://tiles.example.com/"
);

assert.equal(
  entry.tileUrl,
  "https://tiles.example.com/vector.us_counties/{z}/{x}/{y}.pbf",
  "tile URL uses the schema-qualified pg_tileserv path and strips the trailing slash"
);
assert.equal(entry.sourceLayer, "us_counties", "source-layer matches the table name");
assert.equal(entry.type, "vector");
assert.equal(entry.builtin, true);
assert.equal(entry.idColumn, "geoid");

// ---- assertSafeTableName ----

assert.equal(assertSafeTableName("plots_ab12"), "plots_ab12");
for (const bad of [
  "Plots",
  "1plots",
  "plots-1",
  "plots; DROP TABLE x",
  "vector.plots",
  "",
]) {
  assert.throws(
    () => assertSafeTableName(bad),
    /Invalid table name/,
    `rejects ${JSON.stringify(bad)}`
  );
}

// ---- tableNameFor ----

const generated = tableNameFor("Study Plots 2030.geojson");
assert.match(
  generated,
  /^study_plots_2030_[0-9a-f]{8}$/,
  "slugifies the filename and appends a disambiguating suffix"
);
assert.notEqual(
  tableNameFor("same.geojson"),
  tableNameFor("same.geojson"),
  "two uploads of the same filename get distinct tables"
);
assert.match(
  tableNameFor("123.geojson"),
  /^upload_123_[0-9a-f]{8}$/,
  "a name that would start with a digit is prefixed"
);
assert.match(
  tableNameFor("!!!.geojson"),
  /^upload_layer_[0-9a-f]{8}$/,
  "a name with nothing usable still yields a valid identifier"
);

// ---- sourceTableFor / styleableAttributes / buildViewSql ----

assert.equal(sourceTableFor("plots_ab12"), "plots_ab12_src");

assert.deepEqual(
  styleableAttributes(["biomass", "Species", "id", "geom", "props", "n-trees", "ok_1"]),
  ["biomass", "ok_1"],
  "only plain lowercase identifiers that do not collide with the view's own " +
    "columns can become view columns"
);

const viewSql = buildViewSql("plots_ab12", "plots_ab12_src", ["biomass", "Bad Key"]);
assert.match(viewSql, /CREATE VIEW vector\.plots_ab12 AS/);
assert.match(
  viewSql,
  /props ->> 'biomass' AS biomass/,
  "styleable keys are expanded into real columns so ['get', key] resolves"
);
assert.ok(!viewSql.includes("Bad Key"), "unsafe keys are skipped, never quoted in");
assert.match(viewSql, /SELECT id,/, "id is selected for feature lookup");
assert.match(viewSql, /geom\n\s+FROM vector\.plots_ab12_src/, "geom comes last");

assert.match(
  buildViewSql("v", "v_src", []),
  /SELECT id,\s+geom/,
  "a collection with no styleable attributes still produces a valid view"
);

// ---- paintFamily ----

assert.equal(paintFamily("MultiPolygon"), "Polygon");
assert.equal(paintFamily("LineString"), "LineString");
assert.equal(paintFamily("MultiPoint"), "Point");
assert.equal(paintFamily(undefined), "Polygon", "defaults to polygon");

// ---- validateCollection ----

const good = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [0, 0] } },
    { type: "Feature", properties: { b: 2 }, geometry: null },
  ],
};
assert.equal(
  validateCollection(good).length,
  1,
  "features without geometry are dropped rather than failing the upload"
);

assert.throws(() => validateCollection({ type: "Feature" }), /FeatureCollection/);
assert.throws(
  () => validateCollection({ type: "FeatureCollection", features: [] }),
  /no features/
);
assert.throws(
  () =>
    validateCollection({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Sphere" } }],
    }),
  /usable geometry/
);

// ---- collectAttributes ----

assert.deepEqual(
  collectAttributes([
    { properties: { b: 1, a: 2 } },
    { properties: { c: 3 } },
    { properties: null },
  ]),
  ["a", "b", "c"],
  "attribute union is sorted and tolerates missing properties"
);

// ---- Server behaviour with no DATABASE_URL ----

const hadDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const server = createRasterServer({
  publicDir: join(process.cwd(), "public"),
  vectorTileBaseUrl: "https://tiles.example.com",
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const catalog = await fetch(`${baseUrl}/api/vector/layers`);
  assert.equal(catalog.status, 200, "catalog answers 200 without a database");
  const payload = await catalog.json();
  assert.deepEqual(
    payload,
    { layers: [], configured: false },
    "an unconfigured deployment reports an empty catalog rather than an error"
  );

  const upload = await fetch(`${baseUrl}/api/vector/layers?name=plots.geojson`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(good),
  });
  assert.equal(upload.status, 503, "ingest reports unavailable without a database");

  const bounds = await fetch(`${baseUrl}/api/vector/layers/us_states/bounds`);
  assert.equal(bounds.status, 503);

  // Path shapes that must not reach the database layer at all.
  const badName = await fetch(`${baseUrl}/api/vector/layers/Not-A-Table/bounds`);
  assert.equal(badName.status, 404, "an invalid table name never routes");

  const env = await fetch(`${baseUrl}/env.js`);
  const envBody = await env.text();
  assert.match(
    envBody,
    /VECTOR_TILE_BASE_URL: "https:\/\/tiles\.example\.com"/,
    "env.js publishes the tile base URL to the browser"
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (hadDatabaseUrl !== undefined) process.env.DATABASE_URL = hadDatabaseUrl;
}

console.log("vector layer tests passed");
