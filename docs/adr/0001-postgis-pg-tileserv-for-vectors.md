# ADR 0001 — PostGIS + pg_tileserv for vector layers

- **Status:** Accepted
- **Date:** 2026-09-16

## Context

Rasters already had a real answer. A COG is served by TiTiler as
`{z}/{x}/{y}.png`, MapLibre mounts it as a `raster` source, and the browser
only ever receives the tiles in view. Colormap and stretch are query
parameters, so restyling costs a tile refetch and nothing else.

Vectors had no equivalent. The only path was `fetch(url).then(r => r.json())`
into a MapLibre `geojson` source, with three hard-coded paint layers — fill,
line, circle — all painted the same green (`#6ab048`). Consequences:

- The built-in boundaries shipped as 5.3 MB of counties plus 1.9 MB of states,
  downloaded whole, parsed into JS memory and re-tessellated at every zoom.
- No attribute-driven styling. The per-layer `style` object was raster-only
  (colormap/min/max), so a modelled value could not be choropleth'd onto
  counties — arguably the most useful vector operation PERSEUS has.
- No popups and no attribute table.
- No shapefile or GeoPackage support; the README told users to re-export.
- Zoom-to-layer was dead for vectors: `layers.js` read `map.getSource(id).bounds`,
  a property MapLibre's `GeoJSONSource` does not have, so the extent was always
  `undefined`.

The planned work — clipping rasters by vector geometry, drawing custom vectors
and interacting with them like any other layer, richer raster/vector
integration — all needs server-side spatial operations and per-feature
identity. None of that is reachable from a static file downloaded into the tab.

## Decision

Vector data lives in **PostGIS** and is served as Mapbox Vector Tiles by
**pg_tileserv**, both running as Railway services alongside the existing
TiTiler. This mirrors what Data to Science (D2S) already does — `d2s-client.js`
has carried an unused `pg_tileserv` tile-URL builder since before this change.

- `COG → TiTiler → raster tiles` and `PostGIS → pg_tileserv → vector tiles` are
  the two halves of one architecture. The viewer treats them the same way:
  a tile URL, a MapLibre source, styling as configuration.
- Everything publishable lives in the `vector` schema. pg_tileserv connects as
  a dedicated `tileserv` role holding only `USAGE` on that schema and `SELECT`
  on its tables, so a table is published by being put there and by nothing else.
- `vector.layer_registry` carries the display metadata pg_tileserv has no
  concept of: title, label column, default style, attribute list.
- Styling is a MapLibre data-driven expression over the feature's own
  attributes — `interpolate` for numeric ramps, `match` for categories.

### Why not PMTiles

PMTiles was the alternative: a single static tile archive read over HTTP range
requests, needing no server at all, and a closer fit to the "static-first"
framing in PRODUCT.md. It was rejected because the roadmap is explicitly about
*interacting* with vectors — clipping rasters to a polygon, persisting drawn
geometry, querying by attribute. PMTiles is a read-only build artifact; every
one of those features would have needed a database standing behind it anyway,
at which point the tile archive is a second copy of the truth that has to be
rebuilt on every edit. Paying for the database once, now, is cheaper than
paying for it later plus a build pipeline.

The cost is accepted deliberately: two more Railway services, a real dependency
(`pg`) in a project that had none, and a migration step in the deploy path.

## Consequences

- **A clicked vector-tile feature is not measurable.** MVT geometry is clipped
  to its tile, so using it for zonal statistics would compute against a
  truncated polygon. `GET /api/vector/layers/:table/features/:id` re-reads the
  authoritative geometry from PostGIS, and the boundary click handler goes
  through it. Any future consumer of a clicked feature's geometry must too.
- **The viewer still runs without a database.** Every vector endpoint checks
  `isConfigured()` and the catalog returns `{ layers: [], configured: false }`
  rather than an error; `boundary-layers.js` falls back to the static GeoJSON in
  `public/data` when `VECTOR_TILE_BASE_URL` is unset. The static files are kept
  for that reason, and as the input to `pnpm db:load-boundaries`.
- **CORS is mandatory here, unlike for rasters.** Raster tiles are `<img>` GETs
  that need no CORS headers, which is why `tt.d2s.org` works for tiles but
  blocked the zonal-statistics `POST` (see the note in `d2s-client.js`). Vector
  tiles are `fetch`ed as ArrayBuffers and are subject to CORS, so pg_tileserv
  runs with `TS_CORSORIGINS` set. Read access is bounded by the `tileserv`
  role's grants, not by the origin list.
- **Uploads are stored schema-free but published through a view.** An uploaded
  GeoJSON becomes `(id, props jsonb, geom)`, because inferring a column per key
  across heterogeneous uploads invites type conflicts and collisions. But a
  jsonb column reaches MVT as a single JSON *string*, so `["get", "biomass"]`
  would find nothing and attribute styling would silently no-op. Each upload
  therefore also gets a view expanding its keys into real columns, and it is
  the view that is granted to `tileserv`, registered and published — the `_src`
  table behind it is never readable by the tile server. Keys that are not plain
  identifiers are left out of the view; they remain in the table.
- Deploys now have an ordering constraint: `pnpm db:migrate` must run before
  pg_tileserv can authenticate, since the migration creates its role.

## Deferred

Not in this slice, and tracked separately: persisting drawn polygons into
PostGIS so they behave like any other vector layer, and server-side raster
clipping/masking by vector geometry.
