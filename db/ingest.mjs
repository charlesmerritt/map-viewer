/* ----------------------------------------------------------------
   db/ingest.mjs — turn an uploaded GeoJSON FeatureCollection into a
   tile-served PostGIS table.

   Storage stays schema-free — every upload is (id, props jsonb, geom) —
   because uploads are heterogeneous and inferring a column per key invites
   type conflicts and name collisions.

   But a jsonb column reaches MVT as one JSON *string*, so a MapLibre
   expression like ["get", "biomass"] would find nothing and attribute
   styling would silently do nothing. So each upload also gets a view that
   expands its keys into real columns, and it is the view — not the table —
   that is granted to `tileserv`, registered, and published.
   ---------------------------------------------------------------- */

import { randomUUID } from "node:crypto";

import { getPool } from "./client.mjs";
import { assertSafeTableName, registerLayer } from "./registry.mjs";

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

const BATCH_SIZE = 250;

// MapLibre only needs to know whether to draw fills, lines or circles.
export function paintFamily(geometryType) {
  const t = String(geometryType || "");
  if (t.endsWith("Polygon")) return "Polygon";
  if (t.endsWith("LineString")) return "LineString";
  if (t.endsWith("Point")) return "Point";
  return "Polygon";
}

// A stable, collision-free table name derived from the uploaded filename, so
// the table is recognisable in psql without trusting user input as an
// identifier.
export function tableNameFor(displayName) {
  const slug = String(displayName || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const suffix = randomUUID().split("-")[0];
  const base = slug && /^[a-z]/.test(slug) ? slug : `upload_${slug || "layer"}`;
  return assertSafeTableName(`${base}_${suffix}`);
}

// The backing table for a published view. Only the view is granted to
// `tileserv`, so the raw jsonb table is never itself publishable.
export function sourceTableFor(viewName) {
  return assertSafeTableName(`${viewName}_src`);
}

// A jsonb key becomes a view column. Keys that are not plain identifiers are
// skipped rather than quoted: they cannot be referenced by a MapLibre
// expression anyway, and they stay readable in the popup via the id column.
const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/;
const RESERVED_COLUMNS = new Set(["id", "geom", "props"]);

export function styleableAttributes(attributes) {
  return attributes.filter(
    (key) => SAFE_COLUMN.test(key) && !RESERVED_COLUMNS.has(key)
  );
}

export function buildViewSql(viewName, tableName, attributes) {
  const columns = styleableAttributes(attributes).map(
    (key) => `props ->> '${key}' AS ${key}`
  );
  const selectList = ["id", ...columns, "geom"].join(",\n         ");
  return `CREATE VIEW vector.${viewName} AS
       SELECT ${selectList}
         FROM vector.${tableName}`;
}

export function validateCollection(collection) {
  if (!collection || typeof collection !== "object") {
    throw new Error("Body is not valid JSON.");
  }
  if (collection.type !== "FeatureCollection") {
    throw new Error(
      `Expected a GeoJSON FeatureCollection, got ${
        collection.type ? `"${collection.type}"` : "no type"
      }.`
    );
  }
  const features = collection.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("FeatureCollection contains no features.");
  }
  const withGeometry = features.filter(
    (f) => f && f.geometry && GEOMETRY_TYPES.has(f.geometry.type)
  );
  if (withGeometry.length === 0) {
    throw new Error("No features have a usable geometry.");
  }
  return withGeometry;
}

// Union of every property key across the collection — shown in the styling UI
// so a user can colour by an attribute without opening the file themselves.
export function collectAttributes(features) {
  const keys = new Set();
  features.forEach((feature) => {
    Object.keys(feature.properties || {}).forEach((key) => keys.add(key));
  });
  return [...keys].sort();
}

export async function ingestGeoJson(collection, { title, description } = {}) {
  const features = validateCollection(collection);
  // The view carries the public name; the table behind it gets the _src suffix.
  const viewName = tableNameFor(title || "upload");
  const tableName = sourceTableFor(viewName);
  const geometryType = paintFamily(features[0].geometry.type);
  const attributes = collectAttributes(features);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Both names come from tableNameFor/sourceTableFor, which run
    // assertSafeTableName, so interpolating them into DDL is safe. Values are
    // still bound.
    await client.query(
      `CREATE TABLE vector.${tableName} (
         id    bigserial PRIMARY KEY,
         props jsonb NOT NULL DEFAULT '{}'::jsonb,
         geom  geometry(Geometry, 4326) NOT NULL
       )`
    );
    await client.query(
      `CREATE INDEX ${tableName}_geom_idx ON vector.${tableName} USING GIST (geom)`
    );

    let inserted = 0;
    for (let start = 0; start < features.length; start += BATCH_SIZE) {
      const batch = features.slice(start, start + BATCH_SIZE);
      const values = [];
      const tuples = [];
      batch.forEach((feature) => {
        const base = values.length;
        values.push(JSON.stringify(feature.properties || {}));
        values.push(JSON.stringify(feature.geometry));
        tuples.push(
          `($${base + 1}::jsonb, ` +
            `ST_SetSRID(ST_GeomFromGeoJSON($${base + 2}), 4326))`
        );
      });
      const result = await client.query(
        `INSERT INTO vector.${tableName} (props, geom) VALUES ${tuples.join(", ")}`,
        values
      );
      inserted += result.rowCount;
    }

    await client.query(buildViewSql(viewName, tableName, attributes));

    // Only the view is granted. The _src table holds the same data but is not
    // readable by `tileserv`, so it is never published as its own tile layer.
    await client.query(`GRANT SELECT ON vector.${viewName} TO tileserv`);

    await registerLayer(client, viewName, {
      title: title || tableName,
      description: description || null,
      geometryType,
      idColumn: "id",
      labelColumn: styleableAttributes(attributes)[0] || null,
      // Only the attributes that became view columns can be referenced by a
      // MapLibre expression, so only those are offered in the styling UI.
      attributes: styleableAttributes(attributes),
      defaultStyle: { color: "#6ab048", fillOpacity: 0.18, lineWidth: 1.5 },
      minZoom: 0,
      maxZoom: 22,
      isBuiltin: false,
    });

    await client.query("COMMIT");
    return {
      tableName: viewName,
      featureCount: inserted,
      attributes: styleableAttributes(attributes),
      geometryType,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    // A half-created table would otherwise linger and be published empty.
    await client.query(`DROP VIEW IF EXISTS vector.${viewName}`).catch(() => {});
    await client
      .query(`DROP TABLE IF EXISTS vector.${tableName}`)
      .catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function dropLayer(viewName) {
  assertSafeTableName(viewName);
  const tableName = sourceTableFor(viewName);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT is_builtin FROM vector.layer_registry WHERE table_name = $1`,
      [viewName]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    if (rows[0].is_builtin) {
      await client.query("ROLLBACK");
      throw new Error("Built-in layers cannot be deleted.");
    }
    await client.query(`DROP VIEW IF EXISTS vector.${viewName}`);
    await client.query(`DROP TABLE IF EXISTS vector.${tableName}`);
    await client.query(
      `DELETE FROM vector.layer_registry WHERE table_name = $1`,
      [viewName]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
