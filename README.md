# PERSEUS Map Viewer

A lightweight web map viewer for [PERSEUS](https://perseus.uga.edu) forest modeling
outputs. Supports Cloud-Optimized GeoTIFF (COG) rasters, vector layers, and
time-series layers with play/scrub controls.

Both halves of the map are tile-served. Rasters stream from TiTiler as
`COG -> {z}/{x}/{y}.png`; vectors stream from pg_tileserv as
`PostGIS -> {z}/{x}/{y}.pbf`. The browser only ever receives the tiles in view.
The Node server serves the app, provides a streaming byte-range upload endpoint
for local COGs, and exposes the vector catalog and ingest API in front of
PostGIS. See [docs/adr/0001](docs/adr/0001-postgis-pg-tileserv-for-vectors.md)
for why vectors are served this way rather than as static files.

---

## What it does

- **Base layers** — Carto Dark/Voyager, OpenStreetMap, Esri World Imagery, OpenTopoMap.
- **User layers** — add by pasting a URL (COG or GeoJSON), uploading a local file, or
  picking from the built-in catalog (`public/layers.json`).
- **Vector layers** — Mapbox Vector Tiles served from PostGIS by pg_tileserv.
  Pick a published layer from **Add layer -> Vector**, or upload a GeoJSON there
  to publish a new one. Styling is data-driven: colour by any attribute with a
  numeric ramp or per-category colours, and click a feature for its attributes.
  Unlike the browser-side GeoJSON path, nothing is downloaded whole and the
  layer persists across sessions.
- **Built-in boundaries** — toggle simplified US state and county polygons, including
  all states, all counties, all counties in a state, and individual states/counties.
  Served as vector tiles when a tile server is configured, falling back to the
  static GeoJSON in `public/data` when it is not.
- **Polygon drawing & zonal statistics** — draw arbitrary polygons on the map
  (click to add vertices, double-click/Enter to finish) or click a built-in
  state/county polygon, then summarize any raster layer over it: valid pixel
  count, mean, min/max, sum, standard deviation, nodata count, and a value
  histogram. Remote COG URLs (both D2S TiTiler layers and any `http(s)` COG you
  add by URL) are computed server-side via a TiTiler `/cog/statistics` endpoint —
  accurate and low-memory, so it scales to CONUS-sized rasters — falling back to
  in-browser geotiff.js if that request fails. Note this sends the COG URL and
  your polygon to that stats server. Uploaded COGs are streamed to temporary app
  storage and exposed through a public byte-range URL, so they use the same
  TiTiler rendering and statistics paths as remote COGs. Uploaded GeoJSON stays
  entirely in the browser. Clip-to-extent remains stubbed for a future slice.
- **Per-layer controls** — visibility toggle, opacity slider, zoom-to-extent, remove.
- **Layer groups** — multi-select layers, group/ungroup with a toolbar button or `G`,
  collapse groups, and scrub group members with the shared play/scrub time bar.
- **Raster styling** — choose a colormap (viridis, magma, Greens, RdYlGn, …) and
  optionally pin min/max for the color stretch.
- **Time slider** — appears automatically when a visible layer declares a `times`
  array or when a layer group has its slider enabled. Play / pause / loop, four
  speeds, drag to scrub. Each native timestep is loaded lazily and cached.

---

## Local development

You need Node 18+.

```bash
cd map-viewer
corepack enable
pnpm install
pnpm dev
# open http://localhost:3000
```

Do not serve `public/` with a generic static server (VS Code Live Server,
`python -m http.server`, …): `/env.js` only exists on `node server.mjs`, so the
Carto basemaps lose their API key and render with an "API KEY REQUIRED"
watermark. Static servers also cannot proxy local COG uploads — both require
`node server.mjs` (used by `pnpm dev`).
The configured TiTiler cannot fetch `localhost`; to exercise local COG uploads in
development, expose the app through a public tunnel and set `PUBLIC_BASE_URL` to
that tunnel origin.

Windsurf/VS Code workspace settings in `.vscode/settings.json` set the built-in
NPM extension's package manager and script runner to `pnpm` for this repo.

---

## Deploy to Railway

### Option A — Railway CLI

```bash
pnpm dlx @railway/cli login
cd map-viewer
pnpm dlx @railway/cli init      # create a new project
pnpm dlx @railway/cli up        # deploy
pnpm dlx @railway/cli domain    # generate a public URL
```

Railway uses `pnpm-lock.yaml`, runs `pnpm install --prod --frozen-lockfile`, then
starts the app with `pnpm start` (see `railway.json` and `nixpacks.toml`).

### Option B — Railway dashboard

1. Push this folder to a GitHub repo.
2. In Railway, **New Project → Deploy from GitHub**, pick the repo.
3. Railway reads `railway.json` and starts the service.
4. In the service settings, click **Generate Domain**.

No environment variables are required on a normal single-instance Railway
deployment; the upload URL is inferred from forwarded request headers. Optional
settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | inferred | Public origin TiTiler should use to fetch uploads |
| `UPLOAD_DIR` | `.uploads/` | Temporary raster storage directory |
| `MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Maximum accepted raster size |
| `DATABASE_URL` | unset | PostGIS connection string. Unset disables vector layers. |
| `VECTOR_TILE_BASE_URL` | unset | Public origin of the pg_tileserv service |
| `TILESERV_PASSWORD` | unset | Password the migration assigns to the `tileserv` role |
| `MAX_VECTOR_BYTES` | `134217728` (128 MiB) | Maximum accepted GeoJSON upload size |

Uploads on the default Railway filesystem are ephemeral and disappear on restart
or redeploy. Mount a Railway volume at `UPLOAD_DIR` if they must survive those
events. Removing an uploaded layer deletes its temporary file.

---

## Adding your own PERSEUS layers

Edit `public/layers.json`. Each entry has:

```jsonc
{
  "name": "Display name",
  "description": "Optional one-liner",
  "type": "cog" | "geojson",

  // Either a single URL...
  "url": "https://bucket.example.com/path/to/file.tif",

  // ...or a time-series of URLs:
  "times": [
    { "label": "2025", "url": "..._2025.tif" },
    { "label": "2030", "url": "..._2030.tif" }
  ],

  // Optional raster styling
  "style": {
    "colormap": "Greens",   // viridis | magma | inferno | plasma | cividis
                            // Greens | YlGn | RdYlGn | Spectral
    "min": 0,
    "max": 250
  }
}
```

After editing, redeploy (or just push to GitHub if you're using the GitHub
integration — Railway will rebuild).

### Rebuilding built-in administrative boundaries

State/county polygon assets live in `public/data/` and are generated with
GDAL/`ogr2ogr` from the Census Bureau's pre-generalized Cartographic Boundary
Files (1:5,000,000 scale, GENZ2022), which the script downloads automatically:

```bash
pnpm build:admin-boundaries
pnpm test
```

The CB files are cartographically generalized with hierarchy and alignment
maintained, so the build applies no additional simplification. Override the
default sources with `US_STATES_SHP` and `US_COUNTIES_SHP` (a local shapefile
path or a URL). Use the same vintage year for states and counties — Census
warns that areas may not align across years. See
[notes/admin-boundary-vector-sources.md](notes/admin-boundary-vector-sources.md)
for why the older pipeline (naive `ogr2ogr -simplify`) produced choppy
boundaries and for the measured tradeoffs of alternative scales.


---

## Vector layers (PostGIS + pg_tileserv)

Vector data lives in PostGIS and is served as MVT by pg_tileserv, mirroring what
TiTiler does for rasters. Three services run on Railway: the app, `titiler`, and
`pg-tileserv`, plus a `PostGIS` database.

### Services

| Service | Image | Notes |
| --- | --- | --- |
| `PostGIS` | `postgis/postgis:16-master` | Deployed from the Railway `postgis` template, with a volume on `/var/lib/postgresql/data` |
| `pg-tileserv` | `pramsey/pg_tileserv:latest` | Listens on 7800; needs a public domain targeting that port |

`pg-tileserv` needs these variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://tileserv:<TILESERV_PASSWORD>@${{PostGIS.RAILWAY_PRIVATE_DOMAIN}}:5432/railway?sslmode=prefer` |
| `TS_HTTPPORT` | `7800` |
| `TS_CORSORIGINS` | `*` (see the CORS note below) |
| `TS_URLBASE` | the service's own public origin |

The app service needs `DATABASE_URL` (pointed at `${{PostGIS.DATABASE_PRIVATE_URL}}`,
i.e. the superuser — it runs migrations), `TILESERV_PASSWORD`, and
`VECTOR_TILE_BASE_URL`.

### Bootstrap order

pg_tileserv authenticates as a `tileserv` role that **migration 001 creates**, so
a fresh `pg-tileserv` service crash-loops with `password authentication failed
for user "tileserv"` until the app has migrated once. This is expected, and it
resolves itself: `pnpm start` runs `scripts/boot.mjs`, which applies migrations
before starting the server, so the first app deploy fixes the tile service.

To run the steps by hand instead:

```bash
railway run --service map-viewer pnpm db:migrate
railway run --service map-viewer pnpm db:load-boundaries
```

`db:migrate` is idempotent (applied files are tracked in
`vector.schema_migrations`) and `db:load-boundaries` truncates and reloads, so
both are safe to re-run. `db:load-boundaries` reads the same
`public/data/*.geojson` the static fallback uses, so rebuilding boundaries is
still `pnpm build:admin-boundaries` followed by a reload.

### What gets published

pg_tileserv publishes every table the `tileserv` role can read, and that role
holds only `USAGE` on the `vector` schema plus `SELECT` on its tables. **Putting
a table in the `vector` schema publishes it publicly; putting it anywhere else
does not.** That grant, not the CORS origin list, is the access boundary — which
is why `TS_CORSORIGINS` can be `*` for what is public read-only reference data.
Tighten it to the viewer's origin if you would rather not have the tiles
embeddable elsewhere.

`vector.layer_registry` holds the display metadata pg_tileserv has no concept
of — title, label column, default style, attribute list. A table with no
registry row is reachable by URL but never appears in the viewer's catalog.

### CORS differs from rasters

Raster tiles are fetched as `<img>` elements, which need no CORS headers — this
is why `tt.d2s.org` serves tiles fine but blocks the zonal-statistics `POST`.
Vector tiles are `fetch`ed as ArrayBuffers and **are** subject to CORS, so
`TS_CORSORIGINS` must be set or every tile request fails in the browser.

### Uploading vectors

**Add layer -> Vector -> Publish a GeoJSON** posts the file to
`POST /api/vector/layers`, which creates a `(id, props jsonb, geom)` table and
registers it. Properties stay in one `jsonb` column because uploads are
heterogeneous — but a jsonb column reaches MVT as a single JSON *string*, which
no MapLibre `["get", ...]` expression can read. So each upload also gets a view
expanding its keys into real columns, and it is the **view** that is published:
`my_layer` is the view, `my_layer_src` is the table behind it, and only the view
is granted to `tileserv`. Attribute keys that are not plain lowercase
identifiers are omitted from the view and so cannot be styled by. Removing an
uploaded layer drops both. Shapefiles still need converting to GeoJSON first.

### A clicked feature is not measurable

MVT geometry is clipped to the tile it came from. Anything that measures a
polygon — zonal statistics above all — must re-read the authoritative geometry
from PostGIS via `GET /api/vector/layers/:table/features/:id`, which is what the
boundary click handler does. Do not pass a clicked feature's geometry to the
zonal engine.

---

## Hosting your data (COGs)

The viewer fetches COG byte-ranges directly from your storage. Two things have
to be true:

1. **The file must be a real Cloud-Optimized GeoTIFF** — that is, internally
   tiled and overview-laden. If you have a plain GeoTIFF, convert it once:

   ```bash
   gdal_translate input.tif output.tif \
     -of COG -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=AVERAGE
   ```

2. **CORS must allow the viewer's origin.** On S3 / R2:

   ```xml
   <CORSConfiguration>
     <CORSRule>
       <AllowedOrigin>*</AllowedOrigin>
       <AllowedMethod>GET</AllowedMethod>
       <AllowedHeader>Range</AllowedHeader>
       <ExposeHeader>Content-Range</ExposeHeader>
       <ExposeHeader>Content-Length</ExposeHeader>
     </CORSRule>
   </CORSConfiguration>
   ```

   For private data, tighten `AllowedOrigin` to the Railway domain you generated.

GeoJSON has the same CORS requirement, minus the range-request piece.

---

## Zonal statistics and clipping scaffold

1. Toggle built-in state/county polygons from **Add layer → Built-in**.
2. Click one visible polygon on the map.
3. Use the **Zonal tools** sidebar section to open the summarize/clip modal.

The current implementation intentionally stubs zonal-statistics and clip-to-extent
processing. It keeps the UX shell, selected-polygon flow, raster-layer picker, and
Chart.js wiring so a future processing backend can be connected cleanly. Grafana-style
dashboards remain a future integration target.

---

## File layout

```
map-viewer/
├── db/
│   ├── client.mjs      Lazy PostGIS pool (no-ops without DATABASE_URL)
│   ├── registry.mjs    vector.layer_registry reads/writes + catalog shaping
│   ├── ingest.mjs      GeoJSON -> PostGIS table + registration
│   └── migrations/     Ordered .sql, applied by scripts/db-migrate.mjs
├── public/
│   ├── index.html      Layout + CDN scripts
│   ├── styles.css      UI (dark map-app aesthetic)
│   ├── state.js        Single source of truth + event bus
│   ├── layer-groups-core.js Pure layer-group ordering helpers
│   ├── layers.js       COG / GeoJSON / vector-tile loaders, opacity, time swapping
│   ├── vector-tiles.js pg_tileserv client, paint expressions, feature popups
│   ├── raster-upload.js Streaming local-COG upload client
│   ├── boundary-layers.js Built-in US state/county boundary toggles
│   ├── zonal-stats.js  Stubbed zonal tools modal + Chart.js wiring
│   ├── timeslider.js   Time bar UI + playback engine
│   ├── app.js          Bootstrap, sidebar, modal, base layers
│   ├── layers.json     Built-in layer catalog (edit me!)
│   └── data/           Generated state/county GeoJSON + index
├── scripts/            Validation, test, migration and boundary-load scripts
├── server.mjs          Static app + raster upload/range + vector catalog API
├── package.json        pnpm run scripts
├── railway.json        Railway start command
├── nixpacks.toml       Railway build config
└── README.md           You are here
```

---

## Roadmap / known gaps

- No XYZ/WMTS layer support yet (per user choice — easy to add later, ~30 lines
  in `layers.js`).
- No direct shapefile upload support — re-export to GeoJSON, or wire up `shpjs`
  or a server-side `ogr2ogr` step if needed.
- Time slider syncs only the first visible time-aware layer. Multi-layer
  synchronization is a future addition.
- Vector features have popups and attribute styling, but no attribute table and
  no server-side filtering. pg_tileserv supports function layers, so a filtered
  layer is reachable without a client-side pass.
- Drawn polygons are still browser-only — they are not persisted to PostGIS, so
  they cannot be shared, restyled or tile-served like other vector layers.
- Raster clipping by vector geometry remains stubbed; zonal statistics work, but
  writing a masked COG does not.

Everything in `public/` is plain HTML/JS with no build step. The server now has
one runtime dependency (`pg`) for the PostGIS paths.

---

## Project Status (auto-generated 2026-07-01)

**Git status:** On `main`, clean, fully in sync with `origin/main`. Last commit 3 weeks ago ("layer groups").

**Maturity:** Mature — deployed (Railway), documented, has JS test scripts in `scripts/`, and already tracks its own gaps in the Roadmap section above. The app server now also supports temporary local COG uploads for TiTiler-backed rendering.

**Low-hanging fruit:**
- No obvious low-hanging fruit beyond what's already tracked in "Roadmap / known gaps" above (no license file and no CI workflow exist, but given the small no-build-step scope that may be intentional rather than an oversight).
