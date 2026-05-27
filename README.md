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
- **Per-layer controls** — visibility toggle, opacity slider, zoom-to-extent, remove.
- **Raster styling** — choose a colormap (viridis, magma, Greens, RdYlGn, …) and
  optionally pin min/max for the color stretch.
- **Time slider** — appears automatically when a visible layer declares a `times`
  array. Play / pause / loop, four speeds, drag to scrub. Each timestep is loaded
  lazily and cached.

---

## Local development

You need Node 18+.

```bash
cd map-viewer
npm install
npm run dev
# open http://localhost:3000
```

Since this is a pure static app, you can also serve `public/` with any static
file server — `python -m http.server`, `caddy file-server`, `npx http-server`,
etc.

---

## Deploy to Railway

### Option A — Railway CLI

```bash
npm install -g @railway/cli
railway login
cd map-viewer
railway init      # create a new project
railway up        # deploy
railway domain    # generate a public URL
```

Railway will detect Node from `package.json`, run `npm install`, then start the
app with `npx serve -s public -l $PORT` (see `railway.json` and `nixpacks.toml`).

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

## File layout

```
map-viewer/
├── public/
│   ├── index.html      Layout + CDN scripts
│   ├── styles.css      UI (dark map-app aesthetic)
│   ├── state.js        Single source of truth + event bus
│   ├── layers.js       COG / GeoJSON loaders, opacity, time swapping
│   ├── timeslider.js   Time bar UI + playback engine
│   ├── app.js          Bootstrap, sidebar, modal, base layers
│   └── layers.json     Built-in layer catalog (edit me!)
├── package.json        `serve` dependency, npm scripts
├── railway.json        Railway start command
├── nixpacks.toml       Railway build config
└── README.md           You are here
```

---

## Roadmap / known gaps

- No XYZ/WMTS layer support yet (per user choice — easy to add later, ~30 lines
  in `layers.js`).
- No shapefile support — re-export to GeoJSON, or wire up `shpjs` if needed.
- Time slider syncs only the first visible time-aware layer. Multi-layer
  synchronization is a future addition.
- No per-feature filtering / attribute table for vectors yet (click a feature
  for a popup with properties).

Open an issue or extend — everything is plain HTML/JS, no build step.
