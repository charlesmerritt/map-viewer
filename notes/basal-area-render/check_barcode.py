"""Check the barcode hypothesis on served tiles (a single 256 px tile or a
stitched mosaic of them, as written by repro_tiles.py).

TiTiler 0.24.2, titiler/core/utils.py:rescale_array (the fallback used when a
non-uint8 tile is rendered to PNG without `rescale`):

    for bdx in range(nbands):
        array[bdx] = numpy.where(mask[bdx], linear_rescale(array[bdx], ...), 0)

`mask` is ImageData.mask, which is 2-D (H, W), so `mask[0]` is the tile's TOP ROW,
broadcast down every column. Prediction: a valid pixel is 127 (0.5 of the float32
dtype range) iff the top-row pixel of its column is valid, else 0 (black).

  venv/bin/python -I check_barcode.py out/client_z9.png [...]
"""

import sys
import warnings

import numpy as np
import rasterio

warnings.simplefilter("ignore")
for path in sys.argv[1:]:
    with rasterio.open(path) as d:
        a = d.read()
    grey_all, alpha_all = a[0], a[-1]
    tiles = checked = matched = barcode_tiles = black_tiles = 0
    for oy in range(0, grey_all.shape[0], 256):
        for ox in range(0, grey_all.shape[1], 256):
            grey = grey_all[oy:oy + 256, ox:ox + 256]
            valid = alpha_all[oy:oy + 256, ox:ox + 256] > 0
            if not valid.any():
                continue
            tiles += 1
            predicted = np.broadcast_to(np.where(valid[0], 127, 0), grey.shape)
            checked += int(valid.sum())
            matched += int((grey[valid] == predicted[valid]).sum())
            values = set(np.unique(grey[valid]).tolist())
            barcode_tiles += values == {0, 127}
            black_tiles += values == {0}
    print(f"{path.split('/')[-1]}: {tiles} tiles with data, {black_tiles} all-black, "
          f"{barcode_tiles} barcode (0/127 by column); top-row prediction matches "
          f"{matched}/{checked} valid px ({matched / checked:.4%})")
