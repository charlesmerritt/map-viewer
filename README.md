# PERSEUS Map Viewer

A lightweight, static web map viewer for [PERSEUS](https://perseus.uga.edu) forest modeling
outputs. Supports Cloud-Optimized GeoTIFF (COG) rasters, GeoJSON vectors, and
time-series layers with play/scrub controls.

Map rendering remains client-side. The Node server serves the app and provides a
streaming, byte-range-capable upload endpoint so local COGs can be consumed by the
same external TiTiler used for remote COG URLs. No tile cooker or database is
included.

---

## What it does

- **Base layers** — Carto Dark/Voyager, OpenStreetMap, Esri World Imagery, OpenTopoMap.
- **User layers** — add by pasting a URL (COG or GeoJSON), uploading a local file, or
  picking from the built-in catalog (`public/layers.json`).
- **Built-in boundaries** — toggle simplified US state and county polygons, including
  all states, all counties, all counties in a state, and individual states/counties.
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
├── public/
│   ├── index.html      Layout + CDN scripts
│   ├── styles.css      UI (dark map-app aesthetic)
│   ├── state.js        Single source of truth + event bus
│   ├── layer-groups-core.js Pure layer-group ordering helpers
│   ├── layers.js       COG / GeoJSON loaders, opacity, time swapping
│   ├── raster-upload.js Streaming local-COG upload client
│   ├── boundary-layers.js Built-in US state/county boundary toggles
│   ├── zonal-stats.js  Stubbed zonal tools modal + Chart.js wiring
│   ├── timeslider.js   Time bar UI + playback engine
│   ├── app.js          Bootstrap, sidebar, modal, base layers
│   ├── layers.json     Built-in layer catalog (edit me!)
│   └── data/           Generated state/county GeoJSON + index
├── scripts/            Validation and test scripts
├── server.mjs          Static app + temporary raster upload/range server
├── package.json        pnpm run scripts
├── railway.json        Railway start command
├── nixpacks.toml       Railway build config
└── README.md           You are here
```

---

## Roadmap / known gaps

- No XYZ/WMTS layer support yet (per user choice — easy to add later, ~30 lines
  in `layers.js`).
- No direct shapefile upload support — re-export to GeoJSON, or wire up `shpjs` if needed.
- Time slider syncs only the first visible time-aware layer. Multi-layer
  synchronization is a future addition.
- No per-feature filtering / attribute table for vectors yet (click a feature
  for a popup with properties).

Open an issue or extend — everything is plain HTML/JS, no build step.

---

## Project Status (auto-generated 2026-07-01)

**Git status:** On `main`, clean, fully in sync with `origin/main`. Last commit 3 weeks ago ("layer groups").

**Maturity:** Mature — deployed (Railway), documented, has JS test scripts in `scripts/`, and already tracks its own gaps in the Roadmap section above. The app server now also supports temporary local COG uploads for TiTiler-backed rendering.

**Low-hanging fruit:**
- No obvious low-hanging fruit beyond what's already tracked in "Roadmap / known gaps" above (no license file and no CI workflow exist, but given the small no-build-step scope that may be intentional rather than an oversight).
