# PERSEUS Map Viewer

A lightweight, static web map viewer for [PERSEUS](https://perseus.uga.edu) forest modeling
outputs. Supports Cloud-Optimized GeoTIFF (COG) rasters, GeoJSON vectors, and
time-series layers with play/scrub controls.

Everything renders client-side in the browser — no server, no tile cooker, no
database. The Railway deployment is just a static file server.

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
  histogram. Uploaded files and CORS-accessible COG URLs are computed entirely
  in the browser with geotiff.js (reading only the polygon's window, using COG
  overviews for large areas); TiTiler-streamed layers use the tile server's
  `/cog/statistics` endpoint with a client-side fallback. Clip-to-extent
  remains stubbed for a future slice.
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

Since this is a pure static app, you can also serve `public/` with any static
file server — `python -m http.server`, `caddy file-server`, `pnpm dlx http-server`,
etc.

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

That's the whole deployment. No environment variables required.

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

State/county polygon assets live in `public/data/` and are generated from local
shapefiles with GDAL/`ogr2ogr`:

```bash
pnpm build:admin-boundaries
pnpm test
```

By default the script reads `/mnt/d/tl_2022_us_state/tl_2022_us_state.shp` and
`/mnt/d/county_p010g.shp_nt00934/countyp010g.shp`. Override with
`US_STATES_SHP=/path/to/states.shp` and `US_COUNTIES_SHP=/path/to/counties.shp`
if needed.

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
│   ├── boundary-layers.js Built-in US state/county boundary toggles
│   ├── zonal-stats.js  Stubbed zonal tools modal + Chart.js wiring
│   ├── timeslider.js   Time bar UI + playback engine
│   ├── app.js          Bootstrap, sidebar, modal, base layers
│   ├── layers.json     Built-in layer catalog (edit me!)
│   └── data/           Generated state/county GeoJSON + index
├── scripts/            Boundary asset build/validation scripts
├── package.json        `serve` dependency, pnpm scripts
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
