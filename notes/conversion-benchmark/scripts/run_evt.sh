#!/usr/bin/env bash
# EVT queue after R1: stats cost on R1's output, then R2..R4. One run at a time.
set -u
cd /home/chazm/projects/map-viewer/.claude/worktrees/agent-a0fbb1c8925517782/.uploads/t11
export CPL_TMPDIR=$PWD/tmp
SRC=src/LF2024_EVT_CONUS.tif
COMMON="-q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER"

structure() { GDAL_PAM_ENABLED=NO gdalinfo "$1" | grep -E "LAYOUT|COMPRESSION|PREDICTOR|Block=|Overviews" > "logs/$2.structure"; }

# --- Stats on R1 output (PAM on, so .aux.xml lands in out/, which is scratch)
structure out/r1.tif R1
rm -f out/r1.tif.aux.xml
GDAL_PAM_ENABLED=YES GDAL_CACHEMAX=1024 python3 bench.py S1_approx_stats_r1 out/r1.tif -- gdalinfo -approx_stats out/r1.tif
grep -E "Minimum=|STATISTICS_VALID_PERCENT" logs/S1_approx_stats_r1.stderr > logs/S1.values
rm -f out/r1.tif.aux.xml
GDAL_PAM_ENABLED=YES GDAL_CACHEMAX=1024 python3 bench.py S2_exact_stats_r1 out/r1.tif -- gdalinfo -stats out/r1.tif
grep -E "Minimum=|STATISTICS_VALID_PERCENT" logs/S2_exact_stats_r1.stderr > logs/S2.values
rm -f out/r1.tif out/r1.tif.aux.xml

export GDAL_PAM_ENABLED=NO
# --- R2: ZSTD instead of DEFLATE
GDAL_CACHEMAX=1024 python3 bench.py R2_evt_zstd_p2_mode_all_1g out/r2.tif -- gdal_translate $COMMON -co COMPRESS=ZSTD -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS $SRC out/r2.tif
structure out/r2.tif R2; rm -f out/r2.tif

# --- R3: GDAL_CACHEMAX 256 MB (baseline otherwise)
GDAL_CACHEMAX=256 python3 bench.py R3_evt_deflate_p2_mode_all_256m out/r3.tif -- gdal_translate $COMMON -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS $SRC out/r3.tif
structure out/r3.tif R3; rm -f out/r3.tif

# --- R4: single thread (baseline otherwise)
GDAL_CACHEMAX=1024 python3 bench.py R4_evt_deflate_p2_mode_1t_1g out/r4.tif -- gdal_translate $COMMON -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=1 $SRC out/r4.tif
structure out/r4.tif R4; rm -f out/r4.tif
# --- R7: DEFLATE with no predictor (control for predictor 2 on categorical codes)
GDAL_CACHEMAX=1024 python3 bench.py R7_evt_deflate_nopred_mode_all_1g out/r7.tif -- gdal_translate $COMMON -co COMPRESS=DEFLATE -co PREDICTOR=NO -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS $SRC out/r7.tif
structure out/r7.tif R7; rm -f out/r7.tif
rm -f tmp/*
echo "EVT queue done"
