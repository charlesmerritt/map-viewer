# Why basal_area_2076 renders shifted with barcode bars (#10)

## Answer

Both symptoms have one cause. `addTiTilerLayer` sends no `rescale` when `/cog/info` has no `STATISTICS_*`. TiTiler then falls back to its own dtype rescale for a Float32 → PNG tile, and that fallback has a bug.

**(b) Barcode bars.** The fallback is TiTiler 0.24.2's `titiler/core/utils.py:rescale_array`:

```python
array[bdx] = numpy.where(mask[bdx], linear_rescale(array[bdx], in_range=float32 dtype range), 0)
```

`mask` is the 2-D tile mask, so `mask[0]` is the tile's **top row**, broadcast down every column. A valid pixel comes out grey (127, half of the float32 range) when the top-row pixel of its column is valid, and black (0) when it isn't. Columns alternate, so you get vertical bars. `check_barcode.py` predicts every one of the 372,439 valid pixels in all 24 served tiles at z7–z10 (100% match). Even without the bug, the fallback maps 35.7–323.6 onto a ±3.4e38 range, which flattens every value to the same grey.

**(a) "Shifted down".** The geometry is not shifted. The shift is how the bars look on the default **Carto Dark** basemap. Black pixels disappear against it, and grey pixels only exist in tiles whose top row is inside the data. A tile whose top row sits above the raster's north edge comes out solid black. So the visible layer starts at the first tile-row boundary inside the footprint. That boundary is a median **190 px ≈ 50 km** below the real edge at z9 (the zoom that `fitBounds` lands on: 8.76) and 148 px ≈ 20 km at z10. At z7–z8 nothing shows at all. The served tile alpha matches a `gdalwarp -t_srs EPSG:3857` reference at offset (0, 0) with IoU 0.99 at every zoom. The client source is also correct: 4326 `bounds` from `/cog/bounds`, `tileSize` 256, `scheme` xyz.

**Owner: display defaults for Ingested rasters (rescale from Ingest stats), supplied by the Conversion recipe.** `gdal_translate -of COG -stats` (GDAL 3.12, `GDAL_PAM_ENABLED=NO`) writes `STATISTICS_*` into the COG itself. The existing `addTiTilerLayer` code picks them up with no client change; see the "converted" screenshot. Not at fault: the range server (all 206s, no multi-range headers, HEAD correct), the MapLibre tile layer, GDAL 3.9.3, or `bidx`/`resampling`.

**Missing overviews** don't cause either symptom. They cause the request volume. One page load plus one restyle at z≈8.8 made **969 range GETs / 22.4 MB (3.25× the 6.9 MB file)**. Production saw 1,108 requests / 32.7 MB. The same view on the Converted COG made **15 range GETs / 6.2 MB**.

## A standalone client fix can ship before the spec

This trigger is client-side and independent of Ingest: any non-uint8 COG without embedded stats added via the TiTiler URL tab hits it too. Minimal fix in `addTiTilerLayer`: when no rescale is resolved and `infoData.dtype !== "uint8"`, call `GET {titilerBase}/cog/statistics?url=…&bidx=1` and set `rescale` from `percentile_2,percentile_98` (or `min,max`). tt.d2s.org allows this cross-origin (`Access-Control-Allow-Origin: *`, methods GET/HEAD/OPTIONS). On this file a cold call made one full read: 4 range GETs, 6.9 MB, 0.43 s. On a Plain GeoTIFF the size of CONUS that read would be prohibitive. So this is a stopgap for small files and URL layers. Ingest stats remain the real fix.

## Same request on TiTiler 2.4.0 (the self-hosted Railway `:latest`)

With no `rescale`, TiTiler 2.4.0 (GDAL 3.12.2) returns **fully transparent** tiles (`RuntimeWarning: invalid value encountered in cast` on the mask). With `rescale`, its tiles are correct (IoU 0.999). Moving tiles to the self-hosted TiTiler would turn "barcode" into "blank", so always send `rescale` for non-uint8 data.

## Evidence

| | as shipped (no rescale) | with rescale / Converted COG |
|---|---|---|
| browser, Carto Dark, z 8.76 | `img/browser_before_as_shipped.png` | `img/browser_after_converted_cog.png` (client's own stats path) |
| stitched z9 tiles | `img/mosaic_z9_before.png` | `img/mosaic_z9_after_rescale.png` |
| reference | | `img/mosaic_z9_reference_gdalwarp.png` |
| one barcode tile | `img/tile_9_138_211_before.png` | |
| TiTiler 2.4.0, no rescale | `img/mosaic_z9_titiler2.4_no_rescale.png` (empty) | |

Metrics per zoom: `client_metrics.json`, `rescaled_metrics.json`, `latest_*.json`.

## Repro setup

- Local TiTiler **0.24.2 / rasterio 1.4.3 / GDAL 3.9.3 / PROJ 9.4.1**, the exact `/healthz` versions of tt.d2s.org, in a uv venv, with 1 worker. Docker wasn't available. Comparison run: TiTiler 2.4.0 / GDAL 3.12.2.
- `logged-server.mjs` runs the real `createRasterServer()` and logs every `/api/rasters` request (method, path, Range, status, bytes). `summarize_ranges.py` summarizes the log.
- `browser_repro.mjs` uses puppeteer-core with the cached Chrome 148. It drives the real UI (Add layer → Upload file → Add layer) with `D2S.setTiTilerBase` pointed at the local TiTiler, then screenshots the result.
- `repro_tiles.py` fetches the tiles the client requests (`bidx=1`, plus optional params) at z7–z10, stitches them, renders a `gdalwarp` reference on the same grid, and reports alignment, perceived-top-edge offset and visibility.
- `check_barcode.py` tests the top-row-mask prediction pixel by pixel.
- The user's file was copied off `/mnt/d` once. Every GDAL call ran with `GDAL_PAM_ENABLED=NO`. Nothing was sent to any third-party service; only the `/healthz` and `/api` version endpoints of tt.d2s.org were queried.

## Side findings for the Ingest spec

- **Conversion size:** the file has only 577 unique values (FVS stand-level output). On this file `PREDICTOR=YES` (float predictor 3) *inflates* it from 6.9 MB to 15 MB with no overviews and 23 MB with AVERAGE overviews. DEFLATE without a predictor plus AVERAGE overviews gives 12.8 MB; LZW plus NEAREST overviews gives 10.0 MB. Pick the codec and predictor by measurement.
- **Tile layer zoom range:** tilejson reports `minzoom 7, maxzoom 12`, but `addD2STileLayer` sets neither. Below z7 every tile forces a full-resolution read of a no-overview raster.
- **GDAL sidecar probes:** each open sends about 10 `HEAD` 404s (`.ovr`, `.aux`, `.msk`, `.xml`) to the range server. On a self-hosted TiTiler, `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR` removes them. They're harmless.
- **Contrast on a dark basemap:** with grayscale and a min/max rescale, low values still sink into Carto Dark. p2–p98 is 81.5–273.9 against min/max 35.7–323.6. The default colormap belongs in display defaults.
