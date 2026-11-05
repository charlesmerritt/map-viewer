#!/usr/bin/env python3
"""Synthesise a CONUS 30 m continuous Float32 Plain GeoTIFF from real data.

TreeMap2022_CONUS.tif (UInt32 plot IDs, EPSG:5070, 154179x97279, nodata 2^32-1)
is mapped through its own VAT column BALIVE (live basal area, ft2/acre), the
CONUS counterpart of basal_area_2076_final.tif. Output layout copies
basal_area_2076_final.tif: Float32, nodata -9999, 128x128 tiles, LZW, no
overviews, no stats. Reads /mnt/d only (GDAL_PAM_ENABLED=NO), writes argv[1].
"""
import sys, time
import numpy as np
from osgeo import gdal, ogr

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")
gdal.SetCacheMax(512 * 1024 * 1024)

SRC = "/mnt/d/TreeMap-2022/Data/TreeMap2022_CONUS.tif"
VAT = "/mnt/d/TreeMap-2022/Data/TreeMap2022_CONUS.tif.vat.dbf"
dst_path = sys.argv[1]

vat = ogr.Open(VAT, 0)
lyr = vat.GetLayer(0)
pairs = [(int(f.GetField("Value")), f.GetField("BALIVE")) for f in lyr]
lut = np.full(max(v for v, _ in pairs) + 1, -9999.0, dtype=np.float32)
for v, ba in pairs:
    lut[v] = ba if ba is not None else -9999.0
print(f"VAT rows {len(pairs)}, BALIVE range {np.min(lut[lut > -9999]):.3f}..{lut.max():.3f}")

src = gdal.Open(SRC, gdal.GA_ReadOnly)
b = src.GetRasterBand(1)
nodata = int(b.GetNoDataValue())
X, Y = src.RasterXSize, src.RasterYSize
drv = gdal.GetDriverByName("GTiff")
dst = drv.Create(dst_path, X, Y, 1, gdal.GDT_Float32,
                 ["TILED=YES", "BLOCKXSIZE=128", "BLOCKYSIZE=128", "COMPRESS=LZW",
                  "BIGTIFF=YES", "NUM_THREADS=8"])
dst.SetGeoTransform(src.GetGeoTransform())
dst.SetProjection(src.GetProjection())
ob = dst.GetRasterBand(1)
ob.SetNoDataValue(-9999)
ob.SetDescription("BALIVE")

STEP = 256
t0 = time.time()
for y in range(0, Y, STEP):
    n = min(STEP, Y - y)
    ids = b.ReadAsArray(0, y, X, n)
    out = np.full(ids.shape, -9999.0, dtype=np.float32)
    ok = ids != nodata
    out[ok] = lut[ids[ok]]
    ob.WriteArray(out, 0, y)
    if (y // STEP) % 40 == 0:
        print(f"row {y}/{Y} {time.time() - t0:.0f}s", flush=True)
dst.FlushCache()
dst = None
print(f"done {time.time() - t0:.0f}s")
