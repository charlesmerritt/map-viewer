#!/usr/bin/env python3
"""Print the ticket results table (markdown) and the exact commands from logs/results.jsonl."""
import json, os

W = os.path.dirname(os.path.abspath(__file__))
rows = {}
for line in open(os.path.join(W, "logs", "results.jsonl")):
    r = json.loads(line)
    rows[r["label"]] = r

SPEC = [
    ("R1", "R1_evt_deflate_p2_mode_all_1g", "EVT", "DEFLATE, PREDICTOR=2, MODE, ALL_CPUS, cache 1 GB"),
    ("R2", "R2_evt_zstd_p2_mode_all_1g", "EVT", "**ZSTD**, PREDICTOR=2, MODE, ALL_CPUS, 1 GB"),
    ("R3", "R3_evt_deflate_p2_mode_all_256m", "EVT", "DEFLATE, PREDICTOR=2, MODE, ALL_CPUS, **256 MB**"),
    ("R4", "R4_evt_deflate_p2_mode_1t_1g", "EVT", "DEFLATE, PREDICTOR=2, MODE, **NUM_THREADS=1**, 1 GB"),
    ("R7", "R7_evt_deflate_nopred_mode_all_1g", "EVT", "DEFLATE, **PREDICTOR=NO**, MODE, ALL_CPUS, 1 GB"),
    ("R1b", "R1b_evt_deflate_p2_mode_all_1g_with_stats", "EVT", "R1 + **`-stats`**"),
    ("R5", "R5_balive_deflate_p3_avg_all_1g", "BALIVE", "DEFLATE, **PREDICTOR=3**, AVERAGE, ALL_CPUS, 1 GB"),
    ("R6", "R6_balive_deflate_nopred_avg_all_1g", "BALIVE", "DEFLATE, **PREDICTOR=NO**, AVERAGE, ALL_CPUS, 1 GB"),
    ("W1", "W1_fown_4269_to_5070_30m_near", "Forest ownership",
     "**gdalwarp** 4269 to 5070, 30 m, `-r near`; DEFLATE, PREDICTOR=NO, MODE, ALL_CPUS, 1 GB"),
]
STATS = [
    ("S1b", "S1b_approx_stats_evt_plain", "EVT source (Plain GeoTIFF)", "approx"),
    ("S2b", "S2b_exact_stats_evt_plain", "EVT source (Plain GeoTIFF)", "exact"),
    ("S1c", "S1c_approx_stats_evt_cog", "EVT COG (R1b output)", "approx"),
    ("S2c", "S2c_exact_stats_evt_cog", "EVT COG (R1b output)", "exact"),
    ("S5", "S5_exact_stats_balive_plain", "BALIVE source (Plain GeoTIFF)", "exact"),
    ("S3", "S3_approx_stats_r5_cog", "BALIVE COG (R5 output)", "approx"),
    ("S4", "S4_exact_stats_r5_cog", "BALIVE COG (R5 output)", "exact"),
]


def mmss(s):
    s = round(s)
    return f"{s // 60}:{s % 60:02d}"


print("| Run | Input | Recipe | Wall | CPU | Peak RSS | Peak temp | Peak output + temp | Output |")
print("|---|---|---|---:|---:|---:|---:|---:|---:|")
for rid, lab, inp, rec in SPEC:
    r = rows[lab]
    assert r["result"] == "ok", lab
    print(f"| {rid} | {inp} | {rec} | {mmss(r['wall_s'])} | {r['cpu_pct']} | {r['maxrss_gib']:.2f} GiB "
          f"| {r['peak_temp_gib']:.2f} GiB | {r['peak_out_plus_tmp_gib']:.2f} GiB | {r['out_gib']:.2f} GiB |")
print()
print("| Run | Raster | Mode | Wall | Peak RSS | Result |")
print("|---|---|---|---:|---:|---|")
for sid, lab, what, mode in STATS:
    r = rows[lab]
    res = open(os.path.join(W, "logs", f"{lab}.stderr")).read().strip()
    print(f"| {sid} | {what} | {mode} | {r['wall_s']:.0f} s | {r['maxrss_gib']:.2f} GiB | `{res.split(' secs=')[0]}` |")
print()
for rid, lab, _, _ in SPEC:
    r = rows[lab]
    env = " ".join(f"{k}={v}" for k, v in r["env"].items() if k != "CPL_TMPDIR")
    print(f"# {rid}\n{env} CPL_TMPDIR=$SCRATCH/tmp {r['cmd']}")
