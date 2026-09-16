/* ----------------------------------------------------------------
   db/registry.mjs — read and write vector.layer_registry.

   pg_tileserv discovers any geometry table the `tileserv` role can read,
   but it carries no display metadata. The registry supplies the title,
   default styling and label column the viewer needs, and listLayers()
   joins the two so the catalog only ever offers layers that are both
   registered and actually publishable.
   ---------------------------------------------------------------- */

import { query } from "./client.mjs";

// A table name we will interpolate into DDL must be a plain identifier.
// Anything else is rejected outright rather than quoted.
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export function assertSafeTableName(name) {
  if (!SAFE_TABLE_NAME.test(name)) {
    throw new Error(
      `Invalid table name "${name}" — use lowercase letters, digits and underscores.`
    );
  }
  return name;
}

export async function registerLayer(client, tableName, meta) {
  assertSafeTableName(tableName);
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO vector.layer_registry
       (table_name, title, description, geometry_type, id_column, label_column,
        attributes, default_style, min_zoom, max_zoom, is_builtin)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
     ON CONFLICT (table_name) DO UPDATE SET
       title         = EXCLUDED.title,
       description   = EXCLUDED.description,
       geometry_type = EXCLUDED.geometry_type,
       id_column     = EXCLUDED.id_column,
       label_column  = EXCLUDED.label_column,
       attributes    = EXCLUDED.attributes,
       default_style = EXCLUDED.default_style,
       min_zoom      = EXCLUDED.min_zoom,
       max_zoom      = EXCLUDED.max_zoom,
       is_builtin    = EXCLUDED.is_builtin`,
    [
      tableName,
      meta.title,
      meta.description ?? null,
      meta.geometryType ?? "Polygon",
      meta.idColumn ?? null,
      meta.labelColumn ?? null,
      JSON.stringify(meta.attributes ?? []),
      JSON.stringify(meta.defaultStyle ?? {}),
      meta.minZoom ?? 0,
      meta.maxZoom ?? 22,
      meta.isBuiltin ?? false,
    ]
  );
}

// Shape the registry row into the object the browser consumes. Kept separate
// from the SQL so scripts/test-vector-catalog.mjs can exercise it directly.
export function toCatalogEntry(row, tileBaseUrl) {
  const base = String(tileBaseUrl || "").replace(/\/$/, "");
  return {
    id: row.table_name,
    name: row.title,
    description: row.description || "",
    type: "vector",
    sourceLayer: row.table_name,
    // pg_tileserv publishes each table at /{schema}.{table}/{z}/{x}/{y}.pbf
    tileUrl: `${base}/vector.${row.table_name}/{z}/{x}/{y}.pbf`,
    tileJsonUrl: `${base}/vector.${row.table_name}.json`,
    geometryType: row.geometry_type,
    idColumn: row.id_column,
    labelColumn: row.label_column,
    attributes: row.attributes || [],
    style: row.default_style || {},
    minZoom: row.min_zoom,
    maxZoom: row.max_zoom,
    builtin: row.is_builtin,
    bounds: row.bounds || null,
  };
}

export async function listLayers(tileBaseUrl) {
  // The join against information_schema keeps a registry row whose table was
  // dropped from showing up as a layer that 404s on first tile request.
  const { rows } = await query(
    `SELECT r.*
       FROM vector.layer_registry r
       JOIN information_schema.tables t
         ON t.table_schema = 'vector' AND t.table_name = r.table_name
      ORDER BY r.is_builtin DESC, r.title ASC`
  );
  return rows.map((row) => toCatalogEntry(row, tileBaseUrl));
}

export async function getLayer(tableName, tileBaseUrl) {
  assertSafeTableName(tableName);
  const { rows } = await query(
    `SELECT * FROM vector.layer_registry WHERE table_name = $1`,
    [tableName]
  );
  return rows.length ? toCatalogEntry(rows[0], tileBaseUrl) : null;
}

// A clicked vector-tile feature carries geometry clipped to the tile it came
// from, which is fine to draw and wrong to measure. Zonal statistics need the
// authoritative polygon, so the viewer re-fetches it from PostGIS by id.
export async function getFeature(tableName, idColumn, id) {
  assertSafeTableName(tableName);
  assertSafeTableName(idColumn);
  const { rows } = await query(
    `SELECT ST_AsGeoJSON(geom) AS geometry,
            to_jsonb(t) - 'geom' AS properties
       FROM vector.${tableName} t
      WHERE ${idColumn}::text = $1
      LIMIT 1`,
    [String(id)]
  );
  if (rows.length === 0) return null;
  return {
    type: "Feature",
    properties: rows[0].properties || {},
    geometry: JSON.parse(rows[0].geometry),
  };
}

// Extent in EPSG:4326, used for zoom-to-layer. Computed on demand rather than
// cached in the registry so it stays correct after an upload replaces a table.
export async function layerBounds(tableName) {
  assertSafeTableName(tableName);
  const { rows } = await query(
    `SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny,
            ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
       FROM (SELECT ST_Extent(geom) AS e FROM vector.${tableName}) s`
  );
  const row = rows[0];
  if (!row || row.minx === null) return null;
  return [Number(row.minx), Number(row.miny), Number(row.maxx), Number(row.maxy)];
}
