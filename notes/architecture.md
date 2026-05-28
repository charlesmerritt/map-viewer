For **biomass over time**, the simplest reliable architecture is:

```text
model output files
   ↓
preprocess once into cloud-optimized raster tiles
   ↓
store in object storage
   ↓
serve map tiles on demand
   ↓
browser displays only visible tiles for the selected year/timestep
```

Do **not** try to load the raw spatial files directly into the browser, unless they are really small.

For your case, use **Cloud Optimized GeoTIFFs** as the default. COGs are regular GeoTIFFs internally arranged with tiling and overviews so clients or servers can read only the needed byte ranges instead of downloading the whole raster. This is exactly the “large raster in browser-adjacent map app” problem. ([Open Geospatial Consortium][1])

## Recommended stack

### Storage

Use object storage:

```text
s3://your-bucket/biomass/
  scenario_baseline/
    biomass_2025.tif
    biomass_2030.tif
    biomass_2035.tif
  scenario_high_disturbance/
    biomass_2025.tif
    biomass_2030.tif
    biomass_2035.tif
```

Each file should be a **COG**, not a normal GeoTIFF.

Good storage options:

```text
AWS S3
Cloudflare R2
Google Cloud Storage
Azure Blob Storage
DigitalOcean Spaces
```

For a simple academic/research app, **Cloudflare R2** or **DigitalOcean Spaces** is often enough.

## Preprocessing step

Convert model outputs to COGs using GDAL:

```bash
gdal_translate input_biomass_2030.tif output_biomass_2030_cog.tif \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co BLOCKSIZE=512 \
  -co OVERVIEWS=AUTO
```

The GDAL COG driver handles tiling, compression, and overview generation for efficient access. ([GDAL][2])

For biomass visualization, you probably want:

```text
one COG per timestep per scenario
```

Example:

```text
biomass_baseline_2025.cog.tif
biomass_baseline_2030.cog.tif
biomass_baseline_2035.cog.tif
```

That is simpler than one massive multidimensional file.

## Tile server

Use **TiTiler**.

TiTiler is a lightweight dynamic tile service for COGs. It can read a COG from object storage and return browser-friendly map tiles. ([Development Seed][3])

The browser would request URLs like:

```text
/tiles/{z}/{x}/{y}?url=s3://bucket/biomass/scenario_baseline/biomass_2030.tif
```

The tile server returns PNG, JPEG, or WebP tiles.

The browser never sees the giant biomass file. It only sees small map tiles.

## Browser frontend

Use **MapLibre GL JS** if you want modern basemap/vector map behavior.

The frontend state can be simple:

```
selected scenario
selected year
selected color ramp
selected opacity
```

When the user moves the time slider, swap the raster tile URL.

Conceptually:

```js
const tileUrl = `${API_URL}/tiles/{z}/{x}/{y}?scenario=baseline&year=2030`;

map.addSource("biomass", {
  type: "raster",
  tiles: [tileUrl],
  tileSize: 256
});

map.addLayer({
  id: "biomass-layer",
  type: "raster",
  source: "biomass",
  paint: {
    "raster-opacity": 0.75
  }
});
```

## Simplest deployable version

```
Frontend:
  React or plain Vite app
  MapLibre or Leaflet

Backend:
  FastAPI + TiTiler

Storage:
  Cloudflare R2 / S3 / DigitalOcean Spaces

Preprocessing:
  Python script + GDAL
```

Directory:

```
biomass-map-viewer/
  frontend/
    src/
      MapView.tsx
      TimeSlider.tsx
      ScenarioSelect.tsx

  backend/
    app/
      main.py
      catalog.py
      tiler.py

  preprocessing/
    make_cogs.py
    upload_cogs.py

  data_catalog.json
```

Example `data_catalog.json`:

```json
{
  "baseline": {
    "2025": "s3://my-bucket/biomass/baseline/biomass_2025.cog.tif",
    "2030": "s3://my-bucket/biomass/baseline/biomass_2030.cog.tif",
    "2035": "s3://my-bucket/biomass/baseline/biomass_2035.cog.tif"
  },
  "high_disturbance": {
    "2025": "s3://my-bucket/biomass/high_disturbance/biomass_2025.cog.tif",
    "2030": "s3://my-bucket/biomass/high_disturbance/biomass_2030.cog.tif",
    "2035": "s3://my-bucket/biomass/high_disturbance/biomass_2035.cog.tif"
  }
}
```

## When to use other formats

### Use COG when

Your data is mostly:

raster
continuous values
biomass, carbon, canopy height, disturbance probability, suitability
one layer per time/scenario

### Use Zarr when

You truly need a multidimensional data cube:

```text
x, y, time, scenario, variable, ensemble_member
```

Zarr is more natural for large chunked multidimensional arrays, especially climate-style data cubes. It is more complex than COG for a simple map viewer. ([R-Spatial][5])

For your first version, avoid Zarr unless you need analysis across time/ensembles in the browser or API.

## Recommended MVP

Build this first:


1. Export one biomass raster per timestep.
2. Convert each raster to a COG.
3. Upload COGs to object storage.
4. Run TiTiler as the tile API.
5. Build a Leaflet or MapLibre frontend.
6. Add a time slider that swaps tile URLs.

That gives you:

fast rendering
small browser payloads
cheap storage
simple deployment
no custom tile pipeline
no PostGIS raster complexity


## Practical rule

Treat the **COG files as the source of truth for visualization**, and treat the browser as a **tile consumer**, not a spatial-data processor.

The simplest durable architecture is:

```text
COG per timestep + object storage + TiTiler + MapLibre/Leaflet
```

[1]: https://www.ogc.org/standards/ogc-cloud-optimized-geotiff/?utm_source=chatgpt.com "Cloud Optimized GeoTIFF Standard"
[2]: https://gdal.org/en/stable/drivers/raster/cog.html?utm_source=chatgpt.com "COG -- Cloud Optimized GeoTIFF generator"
[3]: https://developmentseed.org/titiler/?utm_source=chatgpt.com "TiTiler"
[4]: https://guide.cloudnativegeo.org/pmtiles/intro.html?utm_source=chatgpt.com "PMTiles - Cloud-Optimized Geospatial Formats Guide"
[5]: https://r-spatial.org/book/09-Large.html?utm_source=chatgpt.com "9 Large data and cloud native"
