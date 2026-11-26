"""People counting for crowd rules: the person detector on the whole region misses people who are small and packed together
(a queue seen from above), so the region is also cut into overlapping tiles, each enlarged to the detector's size. From the tiles
only people the whole-region pass did not already find are added, and a box cut by a tile's inner edge is dropped (the person is
found whole in the neighbouring tile, as the tiles overlap). The count is approximate in a packed crowd, close in a spread one.

    people_boxes(detector, frame, region, whole)   whole-region person boxes plus the small people found in the tiles
"""
import numpy as np

TILE_GRID = 2                # tiles across and down the region
TILE_OVERLAP = 0.25          # share of a tile that overlaps its neighbour
TILE_SIZE = 1280             # detector input for one tile
PERSON_FLOOR = 0.3           # people less sure than this are not counted
EDGE_PX = 3                  # a box this close to a tile's inner edge is cut by it
SAME_PERSON = 0.5            # a tile box covered this much by a box already found is that person
NMS_IOU = 0.5


def _cover(a, b):
    """Share of box a covered by box b."""
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    return w * h / area


def _iou(a, b):
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = w * h
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def tiles(region, grid=TILE_GRID, overlap=TILE_OVERLAP):
    """[(x1, y1, x2, y2)] overlapping tiles covering `region` (pixels)."""
    x1, y1, x2, y2 = region
    w, h = x2 - x1, y2 - y1
    tw, th = w / (grid - (grid - 1) * overlap), h / (grid - (grid - 1) * overlap)
    out = []
    for i in range(grid):
        for j in range(grid):
            tx, ty = x1 + j * tw * (1 - overlap), y1 + i * th * (1 - overlap)
            out.append((int(tx), int(ty), int(min(x2, tx + tw)), int(min(y2, ty + th))))
    return out


def merge(whole, found, region):
    """`whole` plus the boxes of `found` [(box, tile)] that are new people: not cut by an inner tile edge, not already in
    `whole`, and not a repeat of another tile's box. Boxes are (x1, y1, x2, y2, confidence)."""
    rx1, ry1, rx2, ry2 = region
    extra = []
    for box, (tx1, ty1, tx2, ty2) in found:
        x1, y1, x2, y2 = box[:4]
        cut = ((x1 - tx1 < EDGE_PX and tx1 > rx1) or (tx2 - x2 < EDGE_PX and tx2 < rx2)
               or (y1 - ty1 < EDGE_PX and ty1 > ry1) or (ty2 - y2 < EDGE_PX and ty2 < ry2))
        if cut or any(_cover(box, w) >= SAME_PERSON or _cover(w, box) >= SAME_PERSON for w in whole):
            continue
        extra.append(box)
    extra.sort(key=lambda b: -b[4])
    kept = []
    for b in extra:
        if all(_iou(b, k) < NMS_IOU for k in kept):
            kept.append(b)
    return list(whole) + kept


def people_boxes(detector, frame, region, whole):
    """Person boxes in picture pixels, (x1, y1, x2, y2, confidence): `whole` (the region pass, already in picture pixels) plus
    the people only the tiles find. Costs TILE_GRID squared extra detector calls."""
    whole = [tuple(float(v) for v in b[:5]) for b in whole if b[4] >= PERSON_FLOOR]
    found = []
    for t in tiles(region):
        tx1, ty1, tx2, ty2 = t
        if tx2 - tx1 < 32 or ty2 - ty1 < 32:
            continue
        for b in detector.detect(np.ascontiguousarray(frame[ty1:ty2, tx1:tx2]), TILE_SIZE, (0,), conf=PERSON_FLOOR):
            if b[4] >= PERSON_FLOOR:
                found.append(((float(b[0]) + tx1, float(b[1]) + ty1, float(b[2]) + tx1, float(b[3]) + ty1, float(b[4])), t))
    return merge(whole, found, region)
