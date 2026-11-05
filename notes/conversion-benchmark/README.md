# Conversion benchmark: CONUS 30 m Plain GeoTIFF to COG

Resolution of [#11](https://github.com/charlesmerritt/map-viewer/issues/11), measured 2026-11-05. Throwaway research branch; never merged.

Note: the first attempt crashed the WSL host because its scratch dir was RAM-backed tmpfs. The conversion temp dir (`CPL_TMPDIR`) must be on disk, not tmpfs. That is a data point for #13.

## Results: Conversion of CONUS 30 m Plain GeoTIFFs to COG

**Machine:** i9-14900HX, 32 logical CPUs, 15.5 GiB RAM, WSL2, ext4 scratch volume, GDAL 3.12.2. One run at a time. Every run had a watchdog that would kill it at 6 GiB tree RSS, 1.5 GiB MemAvailable or 40 min; none fired (lowest MemAvailable seen: 9.8 GiB). `GDAL_PAM_ENABLED=NO`, `CPL_TMPDIR` in scratch. Inputs were copied as the bare `.tif` only, with no `.ovr` or `.aux.xml`, so each behaves like an Upload. Every output was deleted after it was measured, and nothing was written under `/mnt/d`.

**Inputs**

| Name | Source | Type | Size | File |
|---|---|---|---|---|
| EVT | `LF2024_EVT_CONUS.tif`, `.ovr` hidden | Int16 categorical, 5070 | 156336 x 101538 (15.9 Gpx) | 2.72 GiB, LZW, 128 px tiles, no overviews |
| BALIVE | `TreeMap2022_CONUS.tif` plot IDs mapped through its own VAT `BALIVE` column (live basal area, ft2/ac, the CONUS counterpart of `basal_area_2076_final.tif`) | Float32, 5070, nodata -9999, 17.9% valid | 154179 x 97279 (15.0 Gpx) | 3.99 GiB, LZW, 128 px tiles: the same layout as `basal_area_2076_final.tif` |
| Forest ownership | `US_forest_ownership.tif`, `.ovr` hidden (the CONUS-scale non-5070 raster at hand) | Byte categorical, **EPSG:4269** | 580440 x 249593 (145 Gpx) | 3.60 GiB, LZW, no overviews |

**Conversion runs.** All runs use `BLOCKSIZE=512`. "Peak output + temp" is the disk used by Conversion on top of the Upload itself.

| Run | Input | Recipe | Wall | CPU | Peak RSS | Peak temp | Peak output + temp | Output |
|---|---|---|---:|---:|---:|---:|---:|---:|
| R1 | EVT | DEFLATE, PREDICTOR=2, MODE, ALL_CPUS, cache 1 GB | 3:35 | 1205% | 2.67 GiB | 0.94 GiB | 5.12 GiB | 4.18 GiB |
| R2 | EVT | **ZSTD**, PREDICTOR=2, MODE, ALL_CPUS, 1 GB | 3:38 | 1206% | 2.69 GiB | 0.94 GiB | 5.06 GiB | 4.11 GiB |
| R3 | EVT | DEFLATE, PREDICTOR=2, MODE, ALL_CPUS, **256 MB** | 3:32 | 1237% | 1.25 GiB | 0.94 GiB | 5.12 GiB | 4.18 GiB |
| R4 | EVT | DEFLATE, PREDICTOR=2, MODE, **NUM_THREADS=1**, 1 GB | 9:38 | 99% | 2.09 GiB | 0.94 GiB | 5.12 GiB | 4.18 GiB |
| R7 | EVT | DEFLATE, **PREDICTOR=NO**, MODE, ALL_CPUS, 1 GB | 3:40 | 1251% | 2.69 GiB | 0.94 GiB | 4.22 GiB | 3.28 GiB |
| R1b | EVT | R1 + **`-stats`** | 5:17 | 875% | 2.74 GiB | 0.94 GiB | 5.12 GiB | 4.18 GiB |
| R5 | BALIVE | DEFLATE, **PREDICTOR=3**, AVERAGE, ALL_CPUS, 1 GB | 4:32 | 706% | 2.56 GiB | 3.96 GiB | 16.34 GiB | 12.38 GiB |
| R6 | BALIVE | DEFLATE, **PREDICTOR=NO**, AVERAGE, ALL_CPUS, 1 GB | 4:22 | 695% | 2.58 GiB | 3.96 GiB | 10.56 GiB | 6.60 GiB |
| W1 | Forest ownership | **gdalwarp** 4269 to 5070, 30 m, `-r near`; DEFLATE, PREDICTOR=NO, MODE, ALL_CPUS, 1 GB | 9:16 | 436% | 3.54 GiB | 0.67 GiB | 1.34 GiB | 0.67 GiB |

**Statistics runs.** These force `band.ComputeStatistics()`. `gdalinfo -stats` can't be used to time this, because the LANDFIRE file has `STATISTICS_*` embedded in its GDAL_METADATA tag and the COG driver copies them, so `gdalinfo` just returns them in under a second.

| Run | Raster | Mode | Wall | Peak RSS | Result |
|---|---|---|---:|---:|---|
| S1b | EVT source | approx | <1 s | 0.12 GiB | min -9999, max 9994, mean 1571.2 |
| S2b | EVT source | exact | 105 s | 1.09 GiB | min -9999, max 9994, mean 1559.6 |
| S1c | EVT COG | approx | <1 s | 0.07 GiB | min -9999, **max 9829**, **mean 1379.2** |
| S2c | EVT COG | exact | 100 s | 1.07 GiB | min -9999, max 9994, mean 1559.6 |
| S5 | BALIVE source | exact | 87 s | 1.09 GiB | min 1.80, max 607.81, mean 97.72, 17.92% valid |
| S3 | BALIVE COG | approx | <1 s | 0.07 GiB | **min 4.03, max 248.06, mean 69.16, 60.66% valid** |
| S4 | BALIVE COG | exact | 83 s | 1.07 GiB | min 1.80, max 607.81, mean 97.72, 17.92% valid |

### Findings

1. **The predictor makes both inputs bigger, at no gain in time.**
   - `PREDICTOR=2` makes EVT 27% bigger: 4.18 GiB against 3.28 GiB without it (R1 against R7).
   - `PREDICTOR=3` makes BALIVE 88% bigger: 12.38 GiB against 6.60 GiB (R5 against R6).
   - Wall time is the same within noise.
   - This matches #10, where `basal_area_2076_final.tif` (577 unique values) went from 6.9 MB to 15 MB with predictor 3. Both PERSEUS-style floats are low-cardinality, with values constant within each stand or plot.
   - Predictor 3 might still win on a smooth float such as a DEM. That wasn't measured here, so it shouldn't be the default.
2. **ZSTD and DEFLATE are the same in practice.** ZSTD was 1.5% smaller and 1.4% slower (R2 against R1). There's no reason to move off DEFLATE.
3. **More threads cut wall time but cost CPU.** `NUM_THREADS=ALL_CPUS` was 2.7x faster in wall time (3:35 against 9:38) but used 4.4x the CPU-seconds (2503 s user against 569 s), averaging about 12 cores busy. On a host with few vCPUs or metered CPU, expect the speedup to be smaller.
4. **`GDAL_CACHEMAX` controls memory, not speed.**
   - At 256 MB, peak RSS was 1.25 GiB against 2.67 GiB at 1 GB, with the same wall time (R3 against R1).
   - Peak RSS is roughly the cache plus 1 to 1.7 GiB.
   - The highest peak in the whole matrix was 3.54 GiB, from the warp (W1, 1 GB cache plus `-wm 512`).
5. **Disk: the COG driver keeps a temp overview file until it finishes.**
   - The temp file was 0.94 GiB for EVT and 3.96 GiB for BALIVE.
   - Peak disk during Conversion, counting the Upload, output and temp:
     - EVT: 6.9 GiB without predictor (7.8 GiB with predictor 2).
     - BALIVE: 14.6 GiB without predictor (20.3 GiB with predictor 3).
   - The float COG is larger than its LZW source even without a predictor (6.60 against 3.99 GiB). Overviews add about a third more pixels, and AVERAGE overviews create new float values. In #10, LZW with NEAREST overviews gave the smallest float output (10.0 MB).
6. **Statistics**
   - **`-stats` adds one serial full-resolution pass:** 102 s more on EVT, +48% (R1b against R1).
   - **It does embed fresh stats in the COG with PAM off.** R1b has `STATISTICS_VALID_PERCENT=94.74` and none of the source's COUNT, MEDIAN or COVARIANCES keys, so it recomputed rather than copied.
   - **Exact stats as a separate step:** 83 to 105 s single-threaded per 15 Gpx, about 1.1 GiB RSS.
   - **Approximate stats on a COG are wrong for rescale ranges.** They read the coarsest overview and understate the max by 1.7% on EVT and **59%** on BALIVE. Approximate stats on the plain source (EVT) had the exact min and max.
7. **Reprojection (W1) took 9:16 and 3.54 GiB.**
   - **Scale:** a 145 Gpx EPSG:4269 source became a 20.1 Gpx 5070 grid at 30 m (194938 x 102959).
   - **Against translate:** 2.5x the wall time of the same COG recipe translated on EVT (R7, 3:40), or about 2x per output pixel (27.7 ns against 13.8 ns).
   - **Not a clean A/B:** the source is a different dataset with 9x EVT's pixels, and CPU averaged only 436%, so the warp didn't saturate the cores.
   - **Native resolution:** the source's ~10 m pixels would make a 5070 grid about 9x larger than this. That wasn't run, and on this machine it would likely exceed the 40-minute cap.

### Suggested Conversion default

```
GDAL_CACHEMAX=256 CPL_TMPDIR=<volume with room for output + temp> \
gdal_translate -of COG -co BLOCKSIZE=512 -co COMPRESS=DEFLATE -co PREDICTOR=NO \
  -co OVERVIEW_RESAMPLING=<MODE for integer/categorical, AVERAGE for float> \
  -co NUM_THREADS=ALL_CPUS -co BIGTIFF=IF_SAFER in.tif out.tif
```

- Without `-stats`, Conversion of a CONUS 30 m raster runs in about 3.5 to 4.5 min here. Peak RSS with a 256 MB cache was 1.25 GiB on EVT; the 256 MB cache wasn't run on the float.
- Plan disk for the Upload plus about 1.6x to 2.7x its size for output and temp.
- If stats are needed, budget one more serial pass of about 100 s per 15 Gpx, whether through `-stats` or a separate step. Don't take rescale ranges from approximate stats of the COG.
- If the working-CRS policy reprojects, expect roughly 2.5x the translate time for a CONUS source like the one in W1.

### Caveats

- **One run per recipe.** R1 and R3 do the same work (only the cache differs) and are 3 s apart; the spread across R1, R2, R3 and R7 is 8 s (3:32 to 3:40). Treat wall-time differences under about 4% as noise.
- **Warm page cache.** Source files were cached after the first read (later runs show 0 filesystem input blocks), so the times leave out cold reads. That matters more on network volumes.
- **AVERAGE against MODE wasn't compared on the same raster.** Each input used its type-appropriate method, so the cost difference between the two resampling methods isn't isolated.
- **ZSTD was only run on EVT.** The planned BALIVE ZSTD-p3 run was swapped for DEFLATE with no predictor after the #10 finding.
- **BALIVE is a low-cardinality float** (63,838 distinct plot values), not a smooth surface.
- **EVT nodata.** EVT contains `-9999` pixels while its declared nodata is 32767, so every stats min is -9999. That doesn't matter for a categorical colormap, but it would skew a stretch.

<details><summary>Exact commands</summary>

```
# R1
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=IF_SAFER src/LF2024_EVT_CONUS.tif out/r1.tif
# R2
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=ZSTD -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS src/LF2024_EVT_CONUS.tif out/r2.tif
# R3
GDAL_CACHEMAX=256 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS src/LF2024_EVT_CONUS.tif out/r3.tif
# R4
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=1 src/LF2024_EVT_CONUS.tif out/r4.tif
# R7
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=DEFLATE -co PREDICTOR=NO -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS src/LF2024_EVT_CONUS.tif out/r7.tif
# R1b
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -stats -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS src/LF2024_EVT_CONUS.tif out/r1b.tif
# R5
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=DEFLATE -co PREDICTOR=3 -co OVERVIEW_RESAMPLING=AVERAGE -co NUM_THREADS=ALL_CPUS src/TreeMap2022_BALIVE_CONUS.tif out/r5.tif
# R6
GDAL_CACHEMAX=1024 GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdal_translate -q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER -co COMPRESS=DEFLATE -co PREDICTOR=NO -co OVERVIEW_RESAMPLING=AVERAGE -co NUM_THREADS=ALL_CPUS src/TreeMap2022_BALIVE_CONUS.tif out/r6.tif
# W1
GDAL_CACHEMAX=1024 GDAL_NUM_THREADS=ALL_CPUS GDAL_PAM_ENABLED=NO CPL_TMPDIR=$SCRATCH/tmp gdalwarp -q -t_srs EPSG:5070 -tr 30 30 -tap -r near -multi -wo NUM_THREADS=ALL_CPUS -wm 512 -of COG -co BLOCKSIZE=512 -co COMPRESS=DEFLATE -co PREDICTOR=NO -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=IF_SAFER src/US_forest_ownership.tif out/w1.tif

# Stats (S*): python3 stats.py approx|exact <raster>, which opens read-only with PAM off and calls band.ComputeStatistics(approx_ok)
# BALIVE source: make_balive.py reads the TreeMap tif and its VAT read-only, applies the BALIVE lookup per 256-row strip and writes a Float32 GTiff (TILED, 128x128, LZW, nodata -9999); 2:46, 1.15 GiB RSS
```

Each run was wrapped by `bench.py`, which runs `/usr/bin/time -v` with a 1 s poll for tree RSS, MemAvailable and allocated bytes in `out/` and `tmp/`. Peak RSS is from `time -v`; temp and disk peaks are from the poll.
</details>
