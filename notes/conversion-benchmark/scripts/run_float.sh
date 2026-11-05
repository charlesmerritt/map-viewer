#!/usr/bin/env bash
# Float queue: synthesise BALIVE CONUS Plain GeoTIFF, then R5 (DEFLATE p3) and R6 (DEFLATE no predictor).
set -u
cd /home/chazm/projects/map-viewer/.claude/worktrees/agent-a0fbb1c8925517782/.uploads/t11
export CPL_TMPDIR=$PWD/tmp GDAL_PAM_ENABLED=NO
SRC=src/TreeMap2022_BALIVE_CONUS.tif
COMMON="-q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER"
structure() { gdalinfo "$1" | grep -E "LAYOUT|COMPRESSION|PREDICTOR|Block=|Overviews" > "logs/$2.structure"; }

if [ ! -f "$SRC.done" ]; then
  GDAL_CACHEMAX=512 python3 bench.py P1_make_balive_source $SRC -- python3 make_balive.py $SRC
  touch "$SRC.done"
fi
gdalinfo -nomd $SRC | grep -E "Size is|Block=|NoData|COMPRESSION|Overviews" > logs/P1.structure
ls -l $SRC >> logs/P1.structure
GDAL_CACHEMAX=1024 python3 bench.py S5_exact_stats_balive_plain $SRC -- python3 stats.py exact $SRC

GDAL_CACHEMAX=1024 python3 bench.py R5_balive_deflate_p3_avg_all_1g out/r5.tif -- gdal_translate $COMMON -co COMPRESS=DEFLATE -co PREDICTOR=3 -co OVERVIEW_RESAMPLING=AVERAGE -co NUM_THREADS=ALL_CPUS $SRC out/r5.tif
structure out/r5.tif R5
# stats cost on a float output too (exact), PAM writes into out/ only
GDAL_CACHEMAX=1024 python3 bench.py S3_approx_stats_r5_cog out/r5.tif -- python3 stats.py approx out/r5.tif
GDAL_CACHEMAX=1024 python3 bench.py S4_exact_stats_r5_cog out/r5.tif -- python3 stats.py exact out/r5.tif
rm -f out/r5.tif

# R6: same as R5 but no predictor (predictor 3 grew low-cardinality basal_area_2076 in #10)
GDAL_CACHEMAX=1024 python3 bench.py R6_balive_deflate_nopred_avg_all_1g out/r6.tif -- gdal_translate $COMMON -co COMPRESS=DEFLATE -co PREDICTOR=NO -co OVERVIEW_RESAMPLING=AVERAGE -co NUM_THREADS=ALL_CPUS $SRC out/r6.tif
structure out/r6.tif R6; rm -f out/r6.tif
rm -f tmp/*
echo "float queue done"
