"""More rules in the same pure-logic style as zonerules.py: how things move and how they relate to each other.

Each engine is fed the tracks of one analysed frame, [(track_id, x1, y1, x2, y2, confidence)] in pixels, and a time in seconds, and
answers (info, events) like the engines in zonerules. Track ids say what a track is: people below VEHICLE_ID_OFFSET, vehicles from
there, left-behind-object candidates from OBJECT_ID_OFFSET, phones (a fresh id each frame, never tracked) from PHONE_ID_OFFSET.

  near        a person comes within a set distance of a moving vehicle (pedestrian and vehicle, man and machine)
  fewer       fewer than N people stay in a zone, but at least one (a lone worker where a team is needed)
  absent      nobody is in a zone for a while (a required post is empty)
  wrongway    a line is crossed against the allowed direction
  tailgate    a second person crosses a line the same way within a few seconds of the first
  speeding    a vehicle is faster than a limit (the speed comes from a rough scale: metres across the picture)
  running     a person moves faster than a walking pace, in body heights a second
  abandoned   an object that was near a person stays still with nobody near it
  phone       a phone is held up at a person's head and chest, in a zone

None of them knows about cameras or models, so each is unit-tested on its own (tests/test_move_rules.py).
"""
import math
from collections import deque
from dataclasses import dataclass, field

import cv2
import numpy as np

from qavach.intrusion import FORGET_AFTER_SECONDS, Rule
from qavach.zonerules import (CrowdRule, LineRule, VEHICLE_ID_OFFSET, WHOLE_VIEW, _foot, _side)

OBJECT_ID_OFFSET = 2_000_000
PHONE_ID_OFFSET = 3_000_000
OBJECT_CLASSES = (24, 26, 28)              # COCO: backpack, handbag, suitcase
PHONE_CLASS = 67                           # COCO: cell phone
OBJECT_FLOOR = 0.25
PHONE_FLOOR = 0.25                         # the detector keeps phones above this; each rule then picks its own floor
PHONE_CONFIDENCE = 0.35                    # default: a phone must be at least this sure to count (look-alikes score 0.25 to 0.34)
PHONE_PAD = 0.15                           # a phone this far outside the person's box (share of its width and height) is still in their hands
MOVING_PX = 30.0                           # a vehicle that went this far (at 1280 px wide) in about a second is moving
NEAR_PX = 80.0                             # default: this close (box to box, at 1280 px wide) is "near"
OWNER_PX = 150.0                           # default: an object this close to a person still has someone with it
OBJECT_WOBBLE_PX = 10.0                    # a still object's box moves this much from noise alone
TRAIL_SECONDS = 3.0
PHONE_HOLD_SECONDS = 1.0                   # a phone the detector loses for less than this is still held
PHONE_WRIST_REACH = 0.7                    # with the wrists seen, a phone object must be within this many shoulder widths of one:
                                           # a phone in use is in a hand; binoculars hanging on the chest are not
PHONE_BINOCULARS_SECONDS = 4.0             # after the binoculars posture, phone objects at the person are ignored this long
PHONE_MIN_SIGNS = 2                        # frames that actually show a sign before a spell of phone use counts: one frame
                                           # where binoculars score as a phone must not be carried through the whole time asked
RUN_BODY_HEIGHTS = 1.6                     # default running pace in body heights a second (walking is about 0.8)


def kind_of(track_id):
    """person, vehicle, object or phone, by the id ranges above."""
    if track_id >= PHONE_ID_OFFSET:
        return 'phone'
    if track_id >= OBJECT_ID_OFFSET:
        return 'object'
    return 'vehicle' if track_id >= VEHICLE_ID_OFFSET else 'person'


def _in_zones(zones, point):
    for z in zones:
        if cv2.pointPolygonTest(z.points.astype(np.float32), (float(point[0]), float(point[1])), False) >= 0:
            return z
    return None


def _gap(a, b):
    """Distance in pixels between two boxes' edges; 0 when they touch or overlap."""
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


class _Trail:
    """Where a track has been in the last few seconds: (seconds, foot x, foot y, box height)."""

    def __init__(self):
        self.points = deque()

    def add(self, seconds, foot, height):
        self.points.append((seconds, foot[0], foot[1], height))
        while self.points and seconds - self.points[0][0] > TRAIL_SECONDS:
            self.points.popleft()

    def speed(self, seconds, window=1.0, min_span=0.5):
        """(pixels a second, mean box height) over about `window` seconds, or None when the track is too new to say."""
        old = next((p for p in self.points if seconds - p[0] <= window + 0.3), None)
        if old is None or seconds - old[0] < min_span:
            return None
        new = self.points[-1]
        dt = new[0] - old[0]
        if dt <= 0:
            return None
        height = sum(p[3] for p in self.points if p[0] >= old[0]) / max(1, sum(1 for p in self.points if p[0] >= old[0]))
        return math.hypot(new[1] - old[1], new[2] - old[2]) / dt, height

    def moved(self, seconds, window=1.0):
        old = next((p for p in self.points if seconds - p[0] <= window + 0.3), None)
        if old is None or seconds - old[0] < 0.5:
            return 0.0
        return math.hypot(self.points[-1][1] - old[1], self.points[-1][2] - old[2])


def _info(flagged=False, zone=None):
    return dict(zone=zone, inside=zone is not None, flagged=flagged, moved=True, waiting=False)


@dataclass
class _Watch:
    """What one track needs to remember to be alerted on after a while, and not again too soon."""
    frames: int = 0
    peak: float = 0.0
    since: float = None
    flagged: bool = False
    last_alert: float = None
    alerts: int = 0
    last_seen: float = 0.0
    trail: _Trail = field(default_factory=_Trail)
    extra: float = 0.0
    level: str = None             # phone rule: 'confirmed' or 'possible' for the current spell
    cue: str = None
    cue_conf: float = 0.0
    signs: int = 0                # phone rule: frames in the current spell that showed a sign
    binoculars_until: float = 0.0
    first_sign: float = 0.0


class _SustainedRule:
    """Shared by the per-track rules: a condition that must hold for `dwell_seconds` and `min_frames` frames before one alert,
    then not again for `repeat_seconds`. Subclasses answer `check(...)` each frame."""
    kind = ''
    subject = 'person'

    def __init__(self, zones, rule, scale=1.0):
        self.zones, self.rule, self.scale = zones, rule, scale
        self.state, self.alert_count, self.suppressed_count = {}, 0, 0

    @property
    def watch_points(self):
        return np.concatenate([z.points for z in self.zones])

    def _hold(self, st, seconds, holds, confidence):
        """Advance one track's timer. True when an alert is due now."""
        rule = self.rule
        st.peak = max(st.peak, float(confidence))
        if not holds:
            st.since, st.frames, st.flagged = None, 0, False
            return False
        if st.since is None:
            st.since = seconds
        st.frames += 1
        ready = seconds - st.since >= rule.dwell_seconds and st.frames >= rule.min_frames and st.peak >= rule.min_confidence
        if not ready:
            return False
        if st.flagged:
            again = rule.repeat_seconds > 0 and st.last_alert is not None and seconds - st.last_alert >= rule.repeat_seconds
            if not again:
                return False
        st.flagged = True
        if st.last_alert is not None and seconds - st.last_alert < rule.repeat_seconds:
            self.suppressed_count += 1
            return False
        st.alerts += 1
        st.last_alert = seconds
        self.alert_count += 1
        return True

    def _event(self, track_id, seconds, zone, st, **extra):
        return dict(type='alert', id=track_id, seconds=seconds, zone_id=zone.id if zone else WHOLE_VIEW['id'],
                    zone_name=zone.name if zone else WHOLE_VIEW['name'], confidence=round(st.peak, 3), reentry=st.alerts > 1,
                    dwell=round(seconds - st.since, 2) if st.since is not None else 0.0, frames=st.frames, moved=0.0, **extra)

    def _forget(self, seconds):
        for track_id, st in list(self.state.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.state[track_id]


# ── a person near a moving vehicle ──────────────────────────────────────────────────────────────────────────────────
class NearRule(_SustainedRule):
    kind = 'near'
    subject = 'any'

    def __init__(self, zones, rule, near_px=NEAR_PX, scale=1.0):
        super().__init__(zones, rule, scale)
        self.near_px = near_px
        self.vehicles = {}

    def update(self, seconds, tracks):
        """The alert is on the person; it carries `distance` (pixels, box to box) and the vehicle's id."""
        info, events = {}, []
        vehicles = [t for t in tracks if kind_of(int(t[0])) == 'vehicle']
        moving = []
        for tid, x1, y1, x2, y2, conf in vehicles:
            trail = self.vehicles.setdefault(int(tid), _Watch())
            trail.last_seen = seconds
            trail.trail.add(seconds, _foot(x1, y1, x2, y2), y2 - y1)
            if trail.trail.moved(seconds) >= MOVING_PX * self.scale:
                moving.append((int(tid), (x1, y1, x2, y2)))
            info[int(tid)] = _info()
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            if kind_of(tid) != 'person':
                continue
            st = self.state.setdefault(tid, _Watch())
            st.last_seen = seconds
            zone = _in_zones(self.zones, _foot(x1, y1, x2, y2))
            nearest = None
            if zone is not None:
                for vid, box in moving:
                    gap = _gap((x1, y1, x2, y2), box)
                    if gap <= self.near_px * self.scale and (nearest is None or gap < nearest[0]):
                        nearest = (gap, vid)
            if self._hold(st, seconds, nearest is not None, conf):
                events.append(self._event(tid, seconds, zone, st, distance=round(nearest[0], 1), other=nearest[1] % VEHICLE_ID_OFFSET))
            info[tid] = _info(flagged=st.flagged and nearest is not None, zone=zone.id if zone else None)
        self._forget(seconds)
        for vid, st in list(self.vehicles.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.vehicles[vid]
        return info, events


# ── too few people ──────────────────────────────────────────────────────────────────────────────────────────────────
class CountBelowRule(CrowdRule):
    """The crowd rule turned round: a zone with fewer than `limit` people breaches. `lone` ignores an empty zone (a lone
    worker is one person where a team is needed); without it an empty zone breaches too (a post nobody is at)."""

    def __init__(self, zones, rule, limit, scale=1.0, subject='person', kind='fewer', lone=True):
        super().__init__(zones, rule, limit, scale, subject, kind)
        self.lone = lone

    def breached(self, n):
        return 0 < n < self.limit if self.lone else n < self.limit


# ── lines: wrong way, tailgating ────────────────────────────────────────────────────────────────────────────────────
class WrongWayRule(LineRule):
    """A crossing alerts only when it is NOT in `allowed` (1 right of the line as drawn from its first to its last point, -1 left)."""

    def __init__(self, lines, rule, allowed, scale=1.0, subject='person', kind='wrongway'):
        super().__init__(lines, rule, scale=scale, subject=subject, kind=kind)
        self.allowed = allowed

    def update(self, seconds, tracks):
        info, events = super().update(seconds, tracks)
        kept = [e for e in events if e['type'] != 'alert' or e['direction'] != self.allowed]
        self.alert_count -= len(events) - len(kept)          # the crossings the right way were counted by LineRule; take them back
        return info, kept


class TailgateRule(LineRule):
    """A crossing alerts when another track crossed the same line the same way within `gap_seconds` before it."""

    def __init__(self, lines, rule, gap_seconds=3.0, scale=1.0, subject='person', kind='tailgate'):
        super().__init__(lines, rule, scale=scale, subject=subject, kind=kind)
        self.gap_seconds = gap_seconds
        self.recent = {}                                # (line id, direction) -> [(seconds, track id)]

    def update(self, seconds, tracks):
        info, events = super().update(seconds, tracks)
        kept = []
        for e in events:
            if e['type'] != 'alert':
                kept.append(e)
                continue
            key = (e['zone_id'], e['direction'])
            trail = [(t, i) for t, i in self.recent.get(key, []) if seconds - t <= self.gap_seconds]
            follows = next((i for t, i in reversed(trail) if i != e['id']), None)
            self.recent[key] = trail + [(seconds, e['id'])]
            if follows is None:
                self.alert_count -= 1
                continue
            e['gap'] = round(seconds - max(t for t, i in trail if i == follows), 1)
            e['other'] = follows
            kept.append(e)
        return info, kept


# ── speed ───────────────────────────────────────────────────────────────────────────────────────────────────────────
class SpeedingRule(_SustainedRule):
    kind = 'speeding'
    subject = 'vehicle'

    def __init__(self, zones, rule, limit_kmh, metres_per_px, scale=1.0):
        super().__init__(zones, rule, scale)
        self.limit_kmh, self.metres_per_px = limit_kmh, metres_per_px

    def update(self, seconds, tracks):
        """The alert carries `speed` (km/h) and `limit`. The speed is rough: one scale for the whole picture, so a vehicle
        near the camera reads fast and one far away reads slow."""
        info, events = {}, []
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            st = self.state.setdefault(tid, _Watch())
            st.last_seen = seconds
            foot = _foot(x1, y1, x2, y2)
            zone = _in_zones(self.zones, foot)
            if zone is not None:
                st.trail.add(seconds, foot, y2 - y1)
            measured = st.trail.speed(seconds) if zone is not None else None
            kmh = measured[0] * self.metres_per_px * 3.6 if measured else 0.0
            if self._hold(st, seconds, kmh > self.limit_kmh, conf):
                events.append(self._event(tid, seconds, zone, st, speed=round(kmh, 1), limit=self.limit_kmh))
            info[tid] = _info(flagged=st.flagged and kmh > self.limit_kmh, zone=zone.id if zone else None)
        self._forget(seconds)
        return info, events


class RunningRule(_SustainedRule):
    kind = 'running'
    subject = 'person'

    def __init__(self, zones, rule, body_heights=RUN_BODY_HEIGHTS, scale=1.0):
        super().__init__(zones, rule, scale)
        self.body_heights = body_heights

    def update(self, seconds, tracks):
        """Pace in body heights a second, so a near and a far runner read alike. A walking person is about 0.8."""
        info, events = {}, []
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            st = self.state.setdefault(tid, _Watch())
            st.last_seen = seconds
            foot = _foot(x1, y1, x2, y2)
            zone = _in_zones(self.zones, foot)
            st.trail.add(seconds, foot, y2 - y1)
            measured = st.trail.speed(seconds) if zone is not None else None
            pace = measured[0] / measured[1] if measured and measured[1] > 0 else 0.0
            fast = pace >= self.body_heights
            if self._hold(st, seconds, fast, conf):
                events.append(self._event(tid, seconds, zone, st, speed=round(pace, 2), limit=self.body_heights))
            info[tid] = _info(flagged=st.flagged and fast, zone=zone.id if zone else None)
        self._forget(seconds)
        return info, events


# ── a left-behind object ────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class _Object:
    anchor: tuple = None
    since: float = 0.0
    attended: bool = False          # a person was seen with it at some point: something was left, not just "was there"
    flagged: bool = False
    last_alert: float = None
    alerts: int = 0
    frames: int = 0
    peak: float = 0.0
    last_seen: float = 0.0


class AbandonedRule:
    kind = 'abandoned'
    subject = 'any'

    def __init__(self, zones, rule, owner_px=OWNER_PX, scale=1.0):
        self.zones, self.rule, self.scale, self.owner_px = zones, rule, scale, owner_px
        self.state, self.alert_count, self.suppressed_count = {}, 0, 0

    @property
    def watch_points(self):
        return np.concatenate([z.points for z in self.zones])

    def update(self, seconds, tracks):
        """An object counts as left when it has been near a person, stays still for the rule's time (box moves no more than a
        few pixels), and nobody has been within `owner_px` of it since. The alert is on the object."""
        info, events = {}, []
        rule = self.rule
        people = [t[1:5] for t in tracks if kind_of(int(t[0])) == 'person']
        wobble = OBJECT_WOBBLE_PX * self.scale
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            if kind_of(tid) != 'object':
                continue
            box = (x1, y1, x2, y2)
            foot = _foot(*box)
            zone = _in_zones(self.zones, foot)
            st = self.state.setdefault(tid, _Object())
            st.last_seen, st.peak = seconds, max(st.peak, float(conf))
            attended = any(_gap(box, p) <= self.owner_px * self.scale for p in people)
            if zone is None:
                info[tid] = _info()
                continue
            st.attended = st.attended or attended
            if st.anchor is None or math.dist(foot, st.anchor) > wobble or attended:
                if st.flagged and not attended:
                    pass
                st.anchor, st.since, st.frames = foot, seconds, 0
                st.flagged = st.flagged and not attended
            st.frames += 1
            left_for = seconds - st.since
            ready = (st.attended and not attended and left_for >= rule.dwell_seconds and st.frames >= rule.min_frames
                     and st.peak >= rule.min_confidence)
            again = st.flagged and st.alerts and rule.repeat_seconds > 0 and seconds - st.last_alert >= rule.repeat_seconds
            if ready and (not st.flagged or again):
                st.flagged = True
                st.alerts += 1
                st.last_alert = seconds
                self.alert_count += 1
                events.append(dict(type='alert', id=tid, seconds=seconds, zone_id=zone.id, zone_name=zone.name,
                                   confidence=round(st.peak, 3), reentry=st.alerts > 1, dwell=round(left_for, 2),
                                   frames=st.frames, moved=0.0))
            info[tid] = _info(flagged=st.flagged, zone=zone.id)
        for tid, st in list(self.state.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.state[tid]
        return info, events


# ── a phone held up ─────────────────────────────────────────────────────────────────────────────────────────────────
class PhoneRule(_SustainedRule):
    """A person in a zone using a phone. What can be seen of a phone depends on the scene (scene.py), which the camera runner
    sets on `self.scene` before each update, together with `self.cues`: {person track id: (posture, [lights])} from phonecues.py.

      day, night-lit   the phone object at the person (sure enough) -> phone use
                       a weaker phone object with a call or texting posture -> phone use
      night-lit, dark  a screen's light at the hands or face -> phone use
      any              a flashlight-like light at the hands -> possible phone use (a work torch looks the same)
      any              a hand held at the ear (call posture) without a phone seen -> possible phone use (radios are held there too)
      night-ir         an infrared picture shows little of a screen: a screen's light there is only possible phone use

    An alert says `level`: 'confirmed' when any sure sign was seen during the time held, else 'possible' (to be verified by a
    person), and `cue`, the strongest sign seen."""
    kind = 'phone'
    subject = 'any'

    def __init__(self, zones, rule, phone_confidence=PHONE_CONFIDENCE, scale=1.0):
        super().__init__(zones, rule, scale)
        self.phone_confidence = max(PHONE_FLOOR, float(phone_confidence))
        self.scene = None
        self.cues = {}
        self._last_seconds = None
        self._gap = 0.0

    def in_zone(self, box):
        """The zone a person box is in (by the feet, or by the middle when the feet are cut off), else None. The camera runner
        uses it to look for posture and lights only on people a phone rule cares about."""
        x1, y1, x2, y2 = box
        return _in_zones(self.zones, _foot(x1, y1, x2, y2)) or _in_zones(self.zones, ((x1 + x2) / 2, (y1 + y2) / 2))

    def _signs(self, tid, box, phones, seconds):
        """[(level, cue, confidence)] for one person in this frame, and the zone a phone in their hands is in."""
        x1, y1, x2, y2 = box
        width, height = x2 - x1, y2 - y1
        cue = self.cues.get(tid, (None, []))
        pose, lights = cue[0], cue[1]
        wrists, reach = (cue[2], cue[3]) if len(cue) > 3 else ([], 0.0)    # wrist points and shoulder width, when pose saw them
        st = self.state[tid]
        if pose == 'binoculars':
            st.binoculars_until = seconds + PHONE_BINOCULARS_SECONDS
        night = self.scene in ('night-lit', 'night-dark', 'night-ir')
        signs, zone = [], None
        for _, px1, py1, px2, py2, pconf in phones:
            cx, cy = (px1 + px2) / 2, (py1 + py2) / 2
            if x1 - PHONE_PAD * width <= cx <= x2 + PHONE_PAD * width and y1 - PHONE_PAD * height <= cy <= y2:
                zone = zone or _in_zones(self.zones, (cx, cy))
                if seconds < st.binoculars_until:
                    continue          # binoculars at the face score as a phone up to 0.71 (measured): a phone object is not
                                      # trusted while the binoculars posture was seen; a phone's light at night still counts
                if wrists and min(math.hypot(cx - wx, cy - wy) for wx, wy in wrists) > PHONE_WRIST_REACH * reach:
                    continue          # not in a hand: binoculars or a radio hanging on the chest
                if pconf >= self.phone_confidence:
                    signs.append(('confirmed', 'phone', pconf))
                elif pose in ('call', 'texting'):
                    signs.append(('confirmed', f'phone and {pose} posture', pconf))
        for light in lights:
            if light.kind == 'screen' and self.scene in ('night-lit', 'night-dark'):
                signs.append(('confirmed', 'screen light', light.score))
            elif light.kind == 'screen' and night:
                signs.append(('possible', 'screen light (infrared camera)', light.score))
            elif light.kind == 'flashlight':
                signs.append(('possible', 'flashlight', light.score))
        if pose == 'call' and not signs:
            signs.append(('possible', 'hand at ear', 0.5))
        return signs, zone

    def update(self, seconds, tracks):
        """A phone counts when its centre is inside a person's box (a little beyond it at the sides and top), from the head down
        to the feet. A sign seen within the hold time still counts, because phones and their lights are small and flicker; the
        hold stretches with the time between analysed frames, so a slow camera does not lose every sign between two frames."""
        info, events = {}, []
        if self._last_seconds is not None and seconds > self._last_seconds:
            self._gap = seconds - self._last_seconds
        self._last_seconds = seconds
        hold = max(PHONE_HOLD_SECONDS, 2.2 * self._gap)     # one missed frame between two signs still holds
        phones = [t for t in tracks if kind_of(int(t[0])) == 'phone' and t[5] >= PHONE_FLOOR]
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            if kind_of(tid) != 'person':
                continue
            st = self.state.setdefault(tid, _Watch())
            st.last_seen = seconds
            box = (x1, y1, x2, y2)
            zone = _in_zones(self.zones, _foot(x1, y1, x2, y2))
            signs, phone_zone = self._signs(tid, box, phones, seconds)
            if signs:
                # Feet cut off at the picture's edge are outside a zone drawn a little short of it: the phone in the zone counts too.
                zone = zone or phone_zone or self.in_zone(box)
                if not st.extra or seconds - st.extra > hold:
                    st.level, st.cue, st.cue_conf = None, None, 0.0          # a new spell of phone use
                    st.signs, st.first_sign = 0, seconds
                st.extra = seconds
                st.signs += 1
                for level, cue, sconf in signs:
                    better = (level == 'confirmed' and st.level != 'confirmed') or (level == st.level and sconf > st.cue_conf) or st.level is None
                    if better:
                        st.level, st.cue, st.cue_conf = level, cue, float(sconf)
            # A hand at the ear with no phone seen is weak evidence and pose flickers on hidden hands (binoculars, a helmet
            # strap): it must be seen on every frame of the time asked, with no carry-over between frames.
            carry = 0.0 if st.cue == 'hand at ear' else hold
            holding = zone is not None and st.extra > 0 and seconds - st.extra <= carry and st.signs >= PHONE_MIN_SIGNS
            if holding and st.since is None:
                st.since = st.first_sign                  # the time asked counts from the first sign, not the second
            if self._hold(st, seconds, holding, conf):
                events.append(self._event(tid, seconds, zone, st, level=st.level or 'possible', cue=st.cue or 'phone',
                                          scene=self.scene or 'unknown'))
            info[tid] = _info(flagged=st.flagged and holding, zone=zone.id if zone else None)
        self._forget(seconds)
        return info, events


# what each engine needs the detectors to find
NEEDS = {
    'near': {'person', 'vehicle'},
    'speeding': {'vehicle'},
    'abandoned': {'person', 'object'},
    'phone': {'person', 'phone', 'pose'},   # pose: hand-at-ear and texting postures, and where the hands are for lights at night
    'down': {'person', 'pose'},          # 'pose' is not a detection class: it asks for the pose model on the people found
}
