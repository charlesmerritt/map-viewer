"""Fetch the tiles the viewer would request for an Ingested raster, stitch them,
and compare with a gdalwarp reference render.

Run with the venv that has titiler.application==0.24.2 / rasterio 1.4.3
(GDAL 3.9.3, the same stack as tt.d2s.org):

  GDAL_PAM_ENABLED=NO venv/bin/python -I repro_tiles.py \
      --titiler http://127.0.0.1:8311 --cog http://127.0.0.1:3311/api/rasters/<id>/x.tif \
      --src src.tif --out out/ --zooms 7 8 9 10 --tag client [--param rescale=35.7,323.6 ...]

Writes, per zoom:
  <tag>_z<z>.png         stitched TiTiler tiles (grey + alpha, as served)
  ref_z<z>.png           gdalwarp -t_srs EPSG:3857 -r nearest of the source, same grid
  <tag>_z<z>_diff.png    red = data only in TiTiler render, cyan = data only in reference
and prints footprint metrics: best vertical/horizontal offset of the TiTiler alpha mask
against the reference mask, IoU at offset 0 and at the best offset, and how many
"bar" columns (columns where TiTiler has <50% of the reference's valid pixels).
"""

import argparse
import io
import json
import os
import subprocess
import urllib.parse
import urllib.request
import warnings

import morecantile
import numpy as np
import rasterio
from rasterio.io import MemoryFile

warnings.simplefilter("ignore")
TMS = morecantile.tms.get("WebMercatorQuad")


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def decode_png(data):
    with MemoryFile(data) as mem, mem.open() as ds:
        a = ds.read()
    if a.shape[0] == 2:  # grey + alpha
        return a[0], a[1]
    if a.shape[0] == 4:
        return a[0], a[3]
    return a[0], np.full(a[0].shape, 255, np.uint8)


def stitch(args, z, bounds):
    tiles = list(TMS.tiles(*bounds, [z]))
    xs = [t.x for t in tiles]
    ys = [t.y for t in tiles]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w, h = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    grey = np.zeros((h, w), np.uint8)
    alpha = np.zeros((h, w), np.uint8)
    params = [("url", args.cog)] + [tuple(p.split("=", 1)) for p in args.param]
    qs = urllib.parse.urlencode(params)
    statuses = {}
    for t in tiles:
        url = f"{args.titiler}/cog/tiles/WebMercatorQuad/{z}/{t.x}/{t.y}.png?{qs}"
        status, body = fetch(url)
        statuses[status] = statuses.get(status, 0) + 1
        if status != 200:
            continue
        g, a = decode_png(body)
        oy, ox = (t.y - y0) * 256, (t.x - x0) * 256
        grey[oy:oy + 256, ox:ox + 256] = g
        alpha[oy:oy + 256, ox:ox + 256] = a
    ul = TMS.xy_bounds(morecantile.Tile(x0, y0, z))
    lr = TMS.xy_bounds(morecantile.Tile(x1, y1, z))
    extent = (ul.left, lr.bottom, lr.right, ul.top)
    return grey, alpha, extent, statuses


def reference(args, z, extent, w, h):
    tif = os.path.join(args.out, f"ref_z{z}.tif")
    env = {**os.environ, "GDAL_PAM_ENABLED": "NO"}
    subprocess.run(
        ["gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:3857", "-te", *map(str, extent),
         "-ts", str(w), str(h), "-r", "nearest", "-dstnodata", "-9999", args.src, tif],
        check=True, env=env,
    )
    with rasterio.open(tif) as ds:
        v = ds.read(1)
    os.remove(tif)
    valid = v != -9999
    lo, hi = args.ref_range
    grey = np.where(valid, np.clip((v - lo) / (hi - lo) * 254 + 1, 1, 255), 0).astype(np.uint8)
    return grey, valid


def write_png(path, bands):
    bands = np.stack(bands)
    with rasterio.open(path, "w", driver="PNG", width=bands.shape[2], height=bands.shape[1],
                       count=bands.shape[0], dtype="uint8") as ds:
        ds.write(bands)


def shift(mask, dy, dx):
    out = np.zeros_like(mask)
    h, w = mask.shape
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = mask[ys, xs]
    return out


def iou(a, b):
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


def coarse(mask, k):
    h, w = (mask.shape[0] // k) * k, (mask.shape[1] // k) * k
    return mask[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3)) > 0.05


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--titiler", required=True)
    p.add_argument("--cog", required=True)
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--zooms", type=int, nargs="+", default=[7, 8, 9, 10])
    p.add_argument("--tag", default="client")
    p.add_argument("--param", action="append", default=[])
    p.add_argument("--ref-range", type=float, nargs=2, default=(35.7, 323.6))
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)

    # tilejson exists on both old (0.24) and new (2.x) TiTiler; /cog/bounds only on old.
    tj = json.loads(fetch(f"{args.titiler}/cog/WebMercatorQuad/tilejson.json?url={urllib.parse.quote(args.cog, safe='')}")[1])
    bounds = tj["bounds"]
    results = []
    for z in args.zooms:
        grey, alpha, extent, statuses = stitch(args, z, bounds)
        rgrey, rvalid = reference(args, z, extent, grey.shape[1], grey.shape[0])
        tvalid = alpha > 0
        write_png(os.path.join(args.out, f"{args.tag}_z{z}.png"), [grey, alpha])
        write_png(os.path.join(args.out, f"ref_z{z}.png"), [rgrey, np.where(rvalid, 255, 0).astype(np.uint8)])
        diff = np.zeros((3,) + tvalid.shape, np.uint8) + 255
        only_t = tvalid & ~rvalid
        only_r = rvalid & ~tvalid
        both = tvalid & rvalid
        diff[:, both] = 128
        diff[0, only_t], diff[1, only_t], diff[2, only_t] = 230, 30, 30
        diff[0, only_r], diff[1, only_r], diff[2, only_r] = 0, 190, 210
        write_png(os.path.join(args.out, f"{args.tag}_z{z}_diff.png"), list(diff))

        # Footprint alignment on a coarse (8 px) grid so speckle doesn't dominate.
        k = 8
        ct, cr = coarse(tvalid, k), coarse(rvalid, k)
        best = max(((iou(shift(ct, dy, dx), cr), dy, dx) for dy in range(-12, 13) for dx in range(-6, 7)))
        # Bars: columns where the render has far fewer valid pixels than the reference.
        rc = rvalid.sum(axis=0)
        tc = tvalid.sum(axis=0)
        cols = rc > 20
        bar_cols = int(((tc[cols] / rc[cols]) < 0.5).sum())
        # Perceived top edge on a dark basemap: first row per column whose grey is
        # visibly lighter than black (>= 64), versus the reference's first valid row.
        vis = tvalid & (grey >= 64)
        offs = [int(np.argmax(vis[:, c])) - int(np.argmax(rvalid[:, c]))
                for c in np.where(rvalid.any(axis=0) & vis.any(axis=0))[0]]
        ground_m_per_px = (extent[2] - extent[0]) / grey.shape[1] * np.cos(np.radians(30.2))
        res = {
            "z": z,
            "visible_top_offset_px(median)": int(np.median(offs)) if offs else None,
            "visible_top_offset_km(median)": round(float(np.median(offs)) * ground_m_per_px / 1000, 1) if offs else None,
            "columns_with_no_visible_data": int((rvalid.any(axis=0) & ~vis.any(axis=0)).sum()), "size": list(grey.shape), "statuses": statuses,
            "iou_coarse_at_0": round(iou(ct, cr), 3),
            "best_offset_px(dy,dx)": [best[1] * k, best[2] * k], "iou_coarse_best": round(best[0], 3),
            "valid_px_titiler": int(tvalid.sum()), "valid_px_ref": int(rvalid.sum()),
            "bar_columns(<50% of ref)": bar_cols, "columns_with_ref_data": int(cols.sum()),
            "grey_values_titiler": [int(grey[tvalid].min()), int(grey[tvalid].max())] if tvalid.any() else None,
        }
        results.append(res)
        print(json.dumps(res))
    with open(os.path.join(args.out, f"{args.tag}_metrics.json"), "w") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
