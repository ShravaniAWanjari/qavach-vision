"""Signs of phone use on one person that the object detector cannot give on its own.

    posture(keypoints, box)        'call' (a wrist at the ear) or 'texting' (both hands together in front of the chest), else None
    glow(frame, box, keypoints)    small bright light at the hands or face of a person at night: 'screen' or 'flashlight'
    StaticLights                   lamps, signs and lit windows that are always bright, so a person standing in front of one is
                                   not taken for a person holding a lit phone

Keypoints are the 17 COCO pose points (x, y, confidence) in picture pixels; boxes are (x1, y1, x2, y2) in picture pixels.
"""
from dataclasses import dataclass

import cv2
import numpy as np

NOSE, L_EYE, R_EYE, L_EAR, R_EAR, L_SHOULDER, R_SHOULDER = 0, 1, 2, 3, 4, 5, 6
L_WRIST, R_WRIST, L_HIP, R_HIP = 9, 10, 11, 12
KP_SURE = 0.3                 # a keypoint less sure than this is not used

CALL_REACH = 0.45             # a wrist this close to an ear or the nose (share of the shoulder width, at least 0.2 of the height) is at the ear
TEXT_TOGETHER = 0.6           # both wrists this close together (share of the shoulder width) ...
TEXT_SIDE = 0.4               # ... within the shoulders plus this share of their width at each side, between shoulders and hips

GLOW_LIFT = 60                # a light is at least this much brighter (0-255) than the person's own median brightness ...
GLOW_RATIO = 2.2              # ... and this many times as bright ...
GLOW_MIN = 140                # ... and at least this bright
GLOW_PEAK = 170               # its brightest pixel at least this bright: a screen at night is near the top of the range
GLOW_RING = 0.55              # the ring around the light is at most this share of the light's brightness: a small light
                              # in the dark, not a patch of a lit window or wall
GLOW_WARM = 15                # a light whose red is more than this above its blue is skin or lamp-lit (sodium, tungsten),
                              # not a screen or an LED torch, which are white to blue
GLOW_KEEP = 2                 # at most this many lights are kept per person: a phone is one light, not a lit scene
GLOW_MIN_PIXELS = 2           # smaller spots are noise
GLOW_MAX_SIZE = 0.22          # a light wider than this share of the person's height is a lamp or a lit wall, not a phone
GLOW_REACH = 1.0              # with keypoints: the light is within this many shoulder widths of a wrist or the nose
STRIP_ASPECT = 4.0            # a light this long and thin ...
STRIP_WIDTH = 0.35            # ... and this wide (share of the person's width) is a reflective strip on a vest
FLASH_PEAK = 250              # a flashlight burns out the picture: its core is this bright ...
FLASH_CORE = 0.6              # ... over this share of the light ...
FLASH_SIZE = 0.05             # ... and the light is at least this share of the person's height across
FACE_LIT = 1.6                # the face this many times brighter than the body: lit by a screen held in front of it

STATIC_SCALE = 8              # the static-light map is the picture shrunk this many times
STATIC_BRIGHT = 170           # a place this bright when nobody stands there is a lamp, a sign or a lit window
STATIC_RATE = 0.3             # how fast the map follows the picture (each update)


@dataclass
class Light:
    kind: str                 # 'screen' or 'flashlight'
    score: float              # 0 to 1: how much it looks like a phone's light
    box: tuple                # (x1, y1, x2, y2) in picture pixels
    near_hands: bool          # at a wrist or the face (None without keypoints)
    face_lit: bool


def _kp(keypoints, i):
    if keypoints is None or len(keypoints) <= i or keypoints[i][2] < KP_SURE:
        return None
    return float(keypoints[i][0]), float(keypoints[i][1])


def _scale(keypoints, box):
    """The shoulder width, or a fifth of the person's height when the shoulders are not seen or the person is side-on."""
    height = box[3] - box[1]
    ls, rs = _kp(keypoints, L_SHOULDER), _kp(keypoints, R_SHOULDER)
    width = abs(ls[0] - rs[0]) if ls and rs else 0.0
    return max(width, 0.2 * height)


def posture(keypoints, box):
    """'call' when one wrist is raised to an ear or the face and the other is down, 'texting' when both hands are together in
    front of the chest, 'binoculars' when both hands are raised to the face, else None. Posture alone is never proof: people hold radios to their ears and carry clipboards in both hands."""
    if keypoints is None:
        return None
    reach = _scale(keypoints, box)
    head = [p for p in (_kp(keypoints, L_EAR), _kp(keypoints, R_EAR), _kp(keypoints, NOSE)) if p]
    shoulders = [p for p in (_kp(keypoints, L_SHOULDER), _kp(keypoints, R_SHOULDER)) if p]
    shoulder_y = min(p[1] for p in shoulders) if shoulders else box[1] + 0.25 * (box[3] - box[1])
    wrists = [p for p in (_kp(keypoints, L_WRIST), _kp(keypoints, R_WRIST)) if p]
    raised = [w for w in wrists if w[1] < shoulder_y and any(np.hypot(w[0] - h[0], w[1] - h[1]) < CALL_REACH * reach for h in head)]
    if len(raised) == 1 and len(wrists) == 2 and [w for w in wrists if w is not raised[0]][0][1] > shoulder_y:
        return 'call'                     # one hand at the head and the other seen below the shoulders: a call
    if len(wrists) == 2 and all(w[1] < shoulder_y for w in wrists):
        return 'binoculars'               # both hands up above the shoulders: binoculars (or a helmet strap), not a phone
    if raised:
        return None                       # the other hand hidden: can't tell
    if len(wrists) == 2 and len(shoulders) == 2:
        (lx, ly), (rx, ry) = wrists
        hips = [p for p in (_kp(keypoints, L_HIP), _kp(keypoints, R_HIP)) if p]
        hip_y = max(p[1] for p in hips) if hips else box[1] + 0.6 * (box[3] - box[1])
        left, right = min(p[0] for p in shoulders), max(p[0] for p in shoulders)
        side = TEXT_SIDE * (right - left)
        together = np.hypot(lx - rx, ly - ry) < TEXT_TOGETHER * reach
        in_front = all(left - side <= x <= right + side and shoulder_y < y < hip_y for x, y in wrists)
        if together and in_front:
            return 'texting'
    return None


def glow(frame, box, keypoints=None, static=None):
    """The small bright lights at the hands or face of the person in `box`, best first. A screen is a soft small light near
    the hands or face, often lighting the face from below; a flashlight burns out the picture over a larger area. A light
    that is part of the background (`static`), a reflective vest strip, or one far from the hands is not returned."""
    height_px, width_px = frame.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in box)
    w, h = x2 - x1, y2 - y1
    if w < 2 or h < 4:
        return []
    cx1, cy1 = int(max(0, x1 - 0.25 * w)), int(max(0, y1 - 0.1 * h))
    cx2, cy2 = int(min(width_px, x2 + 0.25 * w)), int(min(height_px, y1 + 0.8 * h))
    if cx2 - cx1 < 2 or cy2 - cy1 < 2:
        return []
    crop = frame[cy1:cy2, cx1:cx2]
    value = crop.max(axis=2) if crop.ndim == 3 else crop
    body = frame[int(max(0, y1)):int(min(height_px, y2)), int(max(0, x1)):int(min(width_px, x2))]
    body_v = body.max(axis=2) if body.ndim == 3 else body
    level = float(np.median(body_v)) if body_v.size else 0.0
    threshold = max(level + GLOW_LIFT, level * GLOW_RATIO, GLOW_MIN)
    mask = (value >= threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    wrists_face = [p for p in (_kp(keypoints, L_WRIST), _kp(keypoints, R_WRIST), _kp(keypoints, NOSE)) if p]
    nose = _kp(keypoints, NOSE)
    face_lit = False
    if nose is not None:
        r = max(1, int(0.06 * h))
        nx, ny = int(nose[0]), int(nose[1])
        face = frame[max(0, ny - r):ny + r, max(0, nx - r):nx + r]
        if face.size:
            face_v = face.max(axis=2) if face.ndim == 3 else face
            face_lit = float(face_v.mean()) >= FACE_LIT * max(level, 8.0)
    found = []
    for i in range(1, count):
        bx, by, bw, bh, area = (int(v) for v in stats[i])
        if area < GLOW_MIN_PIXELS:
            continue
        size = max(bw, bh) / h
        if size > GLOW_MAX_SIZE:
            continue
        if max(bw, bh) / max(1, min(bw, bh)) >= STRIP_ASPECT and bw >= STRIP_WIDTH * w:
            continue                                               # a reflective strip across a vest
        gx, gy = cx1 + bx + bw / 2, cy1 + by + bh / 2
        if not (x1 - 0.2 * w <= gx <= x2 + 0.2 * w):
            continue
        if static is not None and static.is_lit(gx, gy):
            continue
        near = None
        if wrists_face:
            near = min(np.hypot(gx - p[0], gy - p[1]) for p in wrists_face) <= GLOW_REACH * _scale(keypoints, (x1, y1, x2, y2))
            if not near:
                continue
        blob = labels == i
        pixels = value[blob]
        if pixels.max() < GLOW_PEAK:
            continue
        if crop.ndim == 3:
            colour = crop[blob].astype(np.float32).mean(axis=0)            # B, G, R
            if colour[2] - colour[0] > GLOW_WARM:
                continue
        grow = max(2, int(max(bw, bh)))
        ring = cv2.dilate(blob.astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)).astype(bool) & ~blob
        if ring.any() and float(value[ring].mean()) > GLOW_RING * float(pixels.mean()):
            continue
        core = float((pixels >= FLASH_PEAK).mean())
        kind = 'flashlight' if pixels.max() >= FLASH_PEAK and core >= FLASH_CORE and size >= FLASH_SIZE else 'screen'
        score = 0.5 + (0.2 if near else 0.0) + (0.2 if face_lit and kind == 'screen' else 0.0)
        score += min(0.1, (float(pixels.mean()) - threshold) / 600)
        found.append(Light(kind, round(min(0.95, score), 3), (cx1 + bx, cy1 + by, cx1 + bx + bw, cy1 + by + bh), near, face_lit))
    found.sort(key=lambda light: -light.score)
    return found[:GLOW_KEEP]


class StaticLights:
    """Where the picture is bright when nobody stands there: a slowly updated, shrunk brightness map of the picture with the
    people's boxes left out of each update."""

    def __init__(self):
        self.map = None

    def update(self, frame, people_boxes=()):
        value = frame.max(axis=2) if frame.ndim == 3 else frame
        rows, cols = max(1, value.shape[0] // STATIC_SCALE), max(1, value.shape[1] // STATIC_SCALE)
        value = value[:rows * STATIC_SCALE, :cols * STATIC_SCALE]
        # the brightest pixel of each cell, not the average: a small lamp must not fade into the dark around it
        small = value.reshape(rows, STATIC_SCALE, cols, STATIC_SCALE).max(axis=(1, 3)).astype(np.float32)
        keep = np.ones_like(small, dtype=bool)
        for x1, y1, x2, y2 in people_boxes:
            keep[int(max(0, y1 // STATIC_SCALE - 1)):int(y2 // STATIC_SCALE + 2), int(max(0, x1 // STATIC_SCALE - 1)):int(x2 // STATIC_SCALE + 2)] = False
        if self.map is None or self.map.shape != small.shape:
            self.map = np.where(keep, small, 0.0)
            return
        self.map[keep] += STATIC_RATE * (small[keep] - self.map[keep])

    def is_lit(self, x, y):
        if self.map is None:
            return False
        my, mx = int(y // STATIC_SCALE), int(x // STATIC_SCALE)
        if not (0 <= my < self.map.shape[0] and 0 <= mx < self.map.shape[1]):
            return False
        return float(self.map[max(0, my - 1):my + 2, max(0, mx - 1):mx + 2].max()) >= STATIC_BRIGHT


def hands(keypoints, box):
    """([wrist points], shoulder width) for the phone rule's in-hand check; ([], 0.0) when no wrist is seen."""
    wrists = [p for p in (_kp(keypoints, L_WRIST), _kp(keypoints, R_WRIST)) if p]
    return wrists, (_scale(keypoints, box) if wrists else 0.0)
