#!/usr/bin/env bash
# EVT follow-up: forced stats (source plain + COG) and R1 + -stats (in-conversion stats cost, also a near-repeat of R1).
set -u
cd /home/chazm/projects/map-viewer/.claude/worktrees/agent-a0fbb1c8925517782/.uploads/t11
export CPL_TMPDIR=$PWD/tmp GDAL_PAM_ENABLED=NO
SRC=src/LF2024_EVT_CONUS.tif
COMMON="-q -of COG -co BLOCKSIZE=512 -co BIGTIFF=IF_SAFER"

GDAL_CACHEMAX=1024 python3 bench.py S1b_approx_stats_evt_plain $SRC -- python3 stats.py approx $SRC
GDAL_CACHEMAX=1024 python3 bench.py S2b_exact_stats_evt_plain $SRC -- python3 stats.py exact $SRC

GDAL_CACHEMAX=1024 python3 bench.py R1b_evt_deflate_p2_mode_all_1g_with_stats out/r1b.tif -- gdal_translate $COMMON -stats -co COMPRESS=DEFLATE -co PREDICTOR=2 -co OVERVIEW_RESAMPLING=MODE -co NUM_THREADS=ALL_CPUS $SRC out/r1b.tif
gdalinfo out/r1b.tif | grep -E "STATISTICS_|Minimum=" > logs/R1b.embedded_stats
GDAL_CACHEMAX=1024 python3 bench.py S1c_approx_stats_evt_cog out/r1b.tif -- python3 stats.py approx out/r1b.tif
GDAL_CACHEMAX=1024 python3 bench.py S2c_exact_stats_evt_cog out/r1b.tif -- python3 stats.py exact out/r1b.tif
rm -f out/r1b.tif tmp/*
echo "EVT follow-up done"
