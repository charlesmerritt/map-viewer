#!/usr/bin/env python3
"""Force a statistics computation (ignores any embedded STATISTICS_* metadata).

usage: stats.py approx|exact <raster>
Opens read-only with PAM disabled, so nothing is written next to the raster.
"""
import sys, time
from osgeo import gdal

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")
mode, path = sys.argv[1], sys.argv[2]
ds = gdal.Open(path, gdal.GA_ReadOnly)
b = ds.GetRasterBand(1)
t0 = time.time()
mn, mx, mean, sd = b.ComputeStatistics(mode == "approx")
print(f"{mode} min={mn} max={mx} mean={mean:.4f} std={sd:.4f} "
      f"valid_pct={b.GetMetadataItem('STATISTICS_VALID_PERCENT')} "
      f"secs={time.time() - t0:.1f} GDAL_NUM_THREADS={gdal.GetConfigOption('GDAL_NUM_THREADS')}")
