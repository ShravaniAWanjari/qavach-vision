"""Zoom pass for phones. A phone in a worker's hand is a few dozen pixels wide in a wide camera view, below what the detector
finds at full-frame size. So for each person who is small in the picture, their box (with some margin) is cut out, enlarged and
searched again for phones; the boxes found are mapped back to the full picture."""
import cv2
import numpy as np

PHONE_CLASS = 67
PHONE_FLOOR = 0.25            # the same floor as moverules.PHONE_FLOOR: nothing weaker is used, so the detector need not keep it
ZOOM_BELOW = 0.55          # people taller than this share of the picture height are big enough already
ZOOM_MAX_PEOPLE = 4        # the smallest-cost choice: the biggest few people, so the extra work per frame stays bounded
ZOOM_TARGET = 640          # the enlarged crop's long side, in pixels (the size the detector was trained at)
ZOOM_MAX_SCALE = 4.0
PAD_SIDE, PAD_TOP, PAD_BOTTOM = 0.25, 0.10, 0.05


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def zoom_boxes(person_boxes, width, height):
    """The crops to search: (x1, y1, x2, y2) in the picture for each person who is small in it, biggest people first."""
    out = []
    for x1, y1, x2, y2 in sorted(person_boxes, key=lambda b: -(b[2] - b[0]) * (b[3] - b[1])):
        w, h = x2 - x1, y2 - y1
        if w < 8 or h < 16 or h > ZOOM_BELOW * height:
            continue
        out.append((int(max(0, x1 - PAD_SIDE * w)), int(max(0, y1 - PAD_TOP * h)), int(min(width, x2 + PAD_SIDE * w)), int(min(height, y2 + PAD_BOTTOM * h))))
        if len(out) == ZOOM_MAX_PEOPLE:
            break
    return out


def merge(phones, extra):
    """`phones` and `extra` are (n, 6) arrays; a zoomed box that overlaps one already found is dropped when it is no surer."""
    keep = [p for p in phones]
    for e in extra:
        clash = next((i for i, p in enumerate(keep) if _iou(p[:4], e[:4]) > 0.4), None)
        if clash is None:
            keep.append(e)
        elif e[4] > keep[clash][4]:
            keep[clash] = e
    return np.array(keep, dtype=np.float32).reshape(-1, 6)


def zoom_phones(detector, frame, person_boxes):
    """Phones found by looking closer at small people: an (n, 6) array (x1 y1 x2 y2 confidence class) in picture pixels."""
    height, width = frame.shape[:2]
    found = []
    for x1, y1, x2, y2 in zoom_boxes(person_boxes, width, height):
        crop = frame[y1:y2, x1:x2]
        scale = min(ZOOM_MAX_SCALE, ZOOM_TARGET / max(crop.shape[:2]))
        if scale < 1.3:
            continue
        big = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        size = int(np.ceil(max(big.shape[:2]) / 32) * 32)
        for b in detector.detect(np.ascontiguousarray(big), size, (PHONE_CLASS,), conf=PHONE_FLOOR):
            found.append([x1 + b[0] / scale, y1 + b[1] / scale, x1 + b[2] / scale, y1 + b[3] / scale, b[4], b[5]])
    return np.array(found, dtype=np.float32).reshape(-1, 6)
