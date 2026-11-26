"""The rules beyond "a person enters a zone": dwelling, being outside, crossing a line, a crowd, a stopped vehicle.

They are pure logic. Each one is fed the tracks of one analysed frame, [(track_id, x1, y1, x2, y2, confidence)] in pixels, and a
time in seconds, and answers like IntrusionRule does: (info, events). `info[track_id]` says how to draw that track (`flagged`,
`inside`, `waiting`, `moved`) and an `alert` event says what to tell people. No model, no camera, so every rule is unit-tested
on its own (tests/test_zone_rules.py).

  dwells    a person stays in a zone for a long time (loitering). It is the intrusion rule with a long time, and standing still
            counts, so the movement check is off unless the rule asks for it.
  outside   a person is somewhere other than the allowed areas for long enough. The areas the rule picks are the allowed ones.
  crosses   a person or vehicle crosses a line drawn on the camera. It counts when the feet really cross from one side to
            the other, so someone pacing along the line does not set it off.
  crowd     more than N people (or vehicles) stay in a zone for long enough, and it alerts again while it lasts.
  gathering people packed together at one place: the biggest group of people standing close to each other (each within about
            half a body height of another) holds at least N for long enough. Spread-out people do not count however many there are,
            which is what tells it from the crowd rule's head count of a whole zone.
  stopped   a vehicle that was moving comes to a halt in a zone (or anywhere) and stays for long enough. A "vehicle" that has
            never moved is not reported: it is a parked car that was there before the camera looked, or a building the detector
            now and then calls a truck, and the same check keeps a static object from alerting as a moving one (motion.py).

Vehicles come from the same detector as people (COCO car, motorcycle, bus, truck) and are followed by VehicleTracker, a small
box-overlap tracker: a vehicle that is stopped needs no re-identification.

The console's rule fields map like this (see settings_for):
  durationSec   seconds: in the zone (dwells), outside (outside), over the limit (crowd), without moving (stopped)
  minFrames     analysed frames in a row before a track counts
  minConfidence how sure the detector must be at least once
  repeatSec     the same track, line or zone does not alert again for this long
  minMovePx     outside and enters: the feet must have moved this far (rules out a pole called a person);
                stopped: how far a vehicle may creep before it counts as moving again
  crowdOver     crowd: alert when MORE than this many are in the zone
  nearHeights   near: how close a person is to a vehicle, in person heights (box to box; about 1.8 m for 1). Replaces nearPx,
                which is a fixed number of pixels and means a different distance on every camera
  nearMovingOnly near: false also alerts for a person beside a parked vehicle (default true: only a moving vehicle counts)
  minPeople     gathering: alert when a group of at least this many people is packed together
  gatherReach   gathering: how close people stand to belong to one group, in body heights (default 0.5: shoulder to shoulder;
                about 1 for a large, looser crowd)
"""
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from qavach.intrusion import FORGET_AFTER_SECONDS, IntrusionRule, Rule, ZonePx, zones_to_pixels

PERSON_CLASS = 0
VEHICLE_CLASSES = (2, 3, 5, 7)             # COCO: car, motorcycle, bus, truck
VEHICLE_ID_OFFSET = 1_000_000              # vehicle track ids start here, so a person and a vehicle never share an id
VEHICLE_FLOOR = 0.25                       # the detector's floor for vehicles; the rule's "sure" setting sits above it
OUTSIDE_ID = '__outside__'
WHOLE_VIEW = dict(id='__view__', name='the camera view', kind='polygon', points=[[0, 0], [100, 0], [100, 100], [0, 100]])
CONDITIONS = ('enters', 'dwells', 'outside', 'crosses', 'crowd', 'gathering', 'stopped',
              'near', 'fewer', 'absent', 'wrongway', 'tailgate', 'speeding', 'running', 'abandoned', 'phone', 'down')
SUBJECTS = ('person', 'vehicle', 'any')
LINE_DEAD_PX = 12.0                        # feet this close to a line are "on" it: the side is not decided yet (at 1280 px wide)
STOPPED_WOBBLE_PX = 12.0                   # a stopped vehicle's box moves this much from noise alone (at 1280 px wide)
ARRIVE_PX = 40.0                           # a vehicle must have travelled this far (at 1280 px wide) to count as having stopped
CROWD_HOLD_SECONDS = 1.0                   # a crowd that dips under the limit for less than this is still the same crowd
                                           # (stretched to about two frame gaps on a slow camera)
GATHER_REACH = 0.5                         # two people belong to one group when their box centres are this many body heights apart or less
GATHER_DEPTH = 1.0                         # up and down the picture counts the same as across it
GATHER_MIN = 3                             # the smallest group a gathering rule can ask for
CROWD_WINDOW_SECONDS = 4.0                 # the count is the median over this long: people hidden behind others for a frame,
                                           # or a passer-by counted twice, do not make the crowd flicker over and under the limit


# ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────────
def _num(data, key, default=None):
    value = data.get(key)
    return default if value is None else value


def settings_for(data):
    """The detection settings of a console rule as the Rule the engines use. Raises ValueError when out of range.

    Each condition has its own defaults for what the rule does not say."""
    kind = data.get('condition', 'enters')
    if kind not in CONDITIONS:
        raise ValueError(f'No detector for the condition {kind!r}')
    fields = dict(dwell_seconds=data.get('durationSec'), min_frames=data.get('minFrames'), min_confidence=data.get('minConfidence'),
                  repeat_seconds=data.get('repeatSec'), min_motion_px=data.get('minMovePx'))
    if kind == 'dwells':
        fields['dwell_seconds'] = _num(data, 'durationSec', 30.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.4)        # standing still for long: do not trust a flicker
        fields['min_motion_px'] = _num(data, 'minMovePx', 0.0)             # standing still is the point
    elif kind == 'outside':
        fields['dwell_seconds'] = _num(data, 'durationSec', 3.0)
    elif kind == 'stopped':
        fields['dwell_seconds'] = _num(data, 'durationSec', 30.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_motion_px'] = _num(data, 'minMovePx', STOPPED_WOBBLE_PX)
    elif kind == 'crosses':
        fields['min_frames'] = _num(data, 'minFrames', 2)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
    elif kind == 'crowd':
        fields['dwell_seconds'] = _num(data, 'durationSec', 5.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 2)
        if int(_num(data, 'crowdOver', 0) or 0) < 1:
            raise ValueError('A crowd rule needs a limit of at least 1')
    elif kind == 'gathering':
        fields['dwell_seconds'] = _num(data, 'durationSec', 10.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 2)
        if int(_num(data, 'minPeople', 0) or 0) < GATHER_MIN:
            raise ValueError(f'A gathering rule needs a group of at least {GATHER_MIN} people')
        if not 0.2 <= float(_num(data, 'gatherReach', GATHER_REACH)) <= 3.0:
            raise ValueError('How close people stand must be between 0.2 and 3 body heights')
    elif kind == 'near':
        fields['dwell_seconds'] = _num(data, 'durationSec', 0.5)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.45)       # a sign or pole the detector calls a person scores about 0.37
        fields['min_frames'] = _num(data, 'minFrames', 2)
        fields['repeat_seconds'] = _num(data, 'repeatSec', 10.0)
        if _num(data, 'nearPx', 80) <= 0 or _num(data, 'nearHeights', 1.0) <= 0:
            raise ValueError('A distance must be more than 0')
    elif kind in ('fewer', 'absent'):
        fields['dwell_seconds'] = _num(data, 'durationSec', 10.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 2)
        if kind == 'fewer' and int(_num(data, 'minPeople', 0) or 0) < 2:
            raise ValueError('A lone-worker rule needs a team of at least 2')
    elif kind in ('wrongway', 'tailgate'):
        fields['min_frames'] = _num(data, 'minFrames', 2)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        if kind == 'wrongway' and data.get('allowedDir') not in (1, -1):
            raise ValueError('A wrong-way rule needs the allowed direction')
        if kind == 'tailgate' and _num(data, 'gapSec', 3.0) <= 0:
            raise ValueError('The following gap must be more than 0 seconds')
    elif kind == 'speeding':
        fields['dwell_seconds'] = _num(data, 'durationSec', 0.5)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 3)
        if not (_num(data, 'speedKmh', 0) or 0) > 0 or not (_num(data, 'metersAcross', 0) or 0) > 0:
            raise ValueError('A speed rule needs a speed limit and the metres across the picture')
    elif kind == 'running':
        fields['dwell_seconds'] = _num(data, 'durationSec', 1.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 3)
    elif kind == 'abandoned':
        fields['dwell_seconds'] = _num(data, 'durationSec', 60.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 3)
    elif kind == 'down':
        fields['dwell_seconds'] = _num(data, 'durationSec', 5.0)       # down this long without getting up
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 3)
        fields['repeat_seconds'] = _num(data, 'repeatSec', 60.0)
    elif kind == 'phone':
        fields['dwell_seconds'] = _num(data, 'durationSec', 2.0)
        fields['min_confidence'] = _num(data, 'minConfidence', 0.3)
        fields['min_frames'] = _num(data, 'minFrames', 2)
        if not 0 <= _num(data, 'phoneConfidence', 0.35) <= 1:
            raise ValueError('The phone confidence must be between 0 and 1')
    return Rule.from_dict(fields)


def subject_of(data):
    """Who the rule is about. A stopped-vehicle rule is always about vehicles."""
    kind = data.get('condition')
    if kind in ('stopped', 'speeding'):
        return 'vehicle'
    if kind in ('near', 'abandoned', 'phone'):
        return 'any'                     # they look at people and something else together
    if kind in ('running', 'fewer', 'absent', 'tailgate', 'down'):
        return 'person'
    subject = data.get('subject') or 'person'
    return subject if subject in SUBJECTS else 'person'


# ── geometry ────────────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class LinePx:
    id: str
    name: str
    points: np.ndarray            # Nx2 float32, pixels, at least two points

    def segments(self):
        return [(tuple(self.points[i]), tuple(self.points[i + 1])) for i in range(len(self.points) - 1)]


def lines_to_pixels(zones, width, height):
    """Line zones from the console (percent) to pixels. Polygons and degenerate lines are ignored."""
    out = []
    for zone in zones:
        pts = zone.get('points') or []
        if zone.get('kind') != 'line' or len(pts) < 2:
            continue
        px = np.array([[p[0] / 100 * width, p[1] / 100 * height] for p in pts], dtype=np.float32)
        out.append(LinePx(id=str(zone['id']), name=str(zone.get('name') or zone['id']), points=px))
    return out


def _side(a, b, p):
    """Positive when p is to the right of the way from a to b on the screen (y points down), negative to the left."""
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def segments_cross(p1, p2, q1, q2):
    """True when the moves p1 to p2 and q1 to q2 properly cross."""
    d1, d2 = _side(q1, q2, p1), _side(q1, q2, p2)
    d3, d4 = _side(p1, p2, q1), _side(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def distance_to_segment(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _foot(x1, y1, x2, y2):
    return ((x1 + x2) / 2, y2)


# ── outside ─────────────────────────────────────────────────────────────────────────────────────────────────────────
class OutsideRule(IntrusionRule):
    """A track is "in" the made-up zone `outside` whenever its feet are in none of the allowed zones. The dwell, frame,
    confidence, movement and repeat tests are then exactly the intrusion rule's, so there is one set of behaviour to trust."""
    where = ZonePx(id=OUTSIDE_ID, name='outside the allowed areas', points=np.zeros((0, 2), dtype=np.int32),
                   points_pct=[[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]])

    def locate(self, point):
        return None if super().locate(point) else self.where

    @property
    def watch_points(self):
        return None            # someone outside the areas can be anywhere in the picture


# ── crossing a line ─────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class _Crosser:
    frames: int = 0
    peak: float = 0.0
    last_seen: float = 0.0
    anchors: dict = field(default_factory=dict)       # line id -> last foot point clearly on one side of the line
    last_cross: dict = field(default_factory=dict)    # line id -> seconds of the last crossing that alerted
    crossings: int = 0
    flash_until: float = -1e9


@dataclass
class LineRule:
    lines: list
    rule: Rule
    scale: float = 1.0
    subject: str = 'person'
    kind: str = 'crosses'
    state: dict = field(default_factory=dict)
    alert_count: int = 0
    suppressed_count: int = 0
    flash_seconds: float = 2.0              # how long the preview keeps a track that just crossed marked

    @property
    def watch_points(self):
        return np.concatenate([line.points for line in self.lines])

    def update(self, seconds, tracks):
        """Events: 'alert' for a crossing (`direction` is 1 for crossing to the right of the line as drawn from its first
        point to its last, -1 to the left) and 'suppressed' for one the repeat time held back."""
        info, events = {}, []
        rule, dead = self.rule, LINE_DEAD_PX * self.scale
        for track_id, x1, y1, x2, y2, confidence in tracks:
            track_id = int(track_id)
            foot = _foot(x1, y1, x2, y2)
            st = self.state.setdefault(track_id, _Crosser())
            st.frames += 1
            st.peak, st.last_seen = max(st.peak, float(confidence)), seconds
            if st.frames >= rule.min_frames and st.peak >= rule.min_confidence:
                for line in self.lines:
                    segments = line.segments()
                    if min(distance_to_segment(foot, a, b) for a, b in segments) < dead:
                        continue                                     # on the line itself: which side is not decided yet
                    anchor = st.anchors.get(line.id)
                    st.anchors[line.id] = foot
                    if anchor is None:
                        continue
                    hit = next(((a, b) for a, b in segments if segments_cross(anchor, foot, a, b)), None)
                    if hit is None:
                        continue
                    last = st.last_cross.get(line.id)
                    if last is not None and seconds - last < rule.repeat_seconds:
                        self.suppressed_count += 1
                        events.append(dict(type='suppressed', id=track_id, seconds=seconds, zone_id=line.id, zone_name=line.name))
                        continue
                    st.last_cross[line.id] = seconds
                    st.crossings += 1
                    st.flash_until = seconds + self.flash_seconds
                    self.alert_count += 1
                    events.append(dict(type='alert', id=track_id, seconds=seconds, zone_id=line.id, zone_name=line.name,
                                       confidence=round(st.peak, 3), reentry=st.crossings > 1, dwell=0.0, frames=st.frames,
                                       moved=0.0, direction=1 if _side(*hit, foot) > 0 else -1))
            flagged = seconds < st.flash_until
            info[track_id] = dict(zone=None, inside=False, flagged=flagged, moved=True, waiting=False)
        for track_id, st in list(self.state.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.state[track_id]
        return info, events


# ── a crowd ─────────────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class _Crowd:
    counts: list = field(default_factory=list)   # (seconds, people) in the last CROWD_WINDOW_SECONDS
    over_since: float = None
    last_over: float = -1e9
    flagged: bool = False
    last_alert: float = None
    alerts: int = 0
    now: int = 0                                 # the smoothed count, for the live preview
    box: tuple = None                            # gathering: where the biggest group is now, (x1, y1, x2, y2)


def biggest_group(feet, reach=GATHER_REACH, depth=GATHER_DEPTH):
    """The largest set of people standing close together: [(centre x, centre y, body height)] -> (size, (x1, y1, x2, y2) round
    them). Two people are linked when the centres of their boxes are within `reach` body heights (the taller of the two sets the
    yardstick, so a far-off small figure and a near big one are judged fairly), and a group is everyone linked by a chain of such
    pairs. Centres, not feet: in a tight circle the people behind have their feet hidden, so their box bottoms say nothing."""
    n = len(feet)
    if n == 0:
        return 0, None
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(n):
        xi, yi, hi = feet[i]
        for j in range(i + 1, n):
            xj, yj, hj = feet[j]
            if math.hypot(xi - xj, depth * (yi - yj)) <= reach * max(hi, hj):
                parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    best = max(groups.values(), key=len)
    xs = [feet[i][0] for i in best]
    pad = max(feet[i][2] for i in best) * 0.3
    return len(best), (min(xs) - pad, min(feet[i][1] - feet[i][2] / 2 for i in best) - pad,
                       max(xs) + pad, max(feet[i][1] + feet[i][2] / 2 for i in best) + pad)


@dataclass
class CrowdRule:
    zones: list
    rule: Rule
    limit: int                             # alert when MORE than this many are in a zone
    scale: float = 1.0
    subject: str = 'person'
    kind: str = 'crowd'
    state: dict = field(default_factory=dict)         # zone id -> _Crowd
    seen: dict = field(default_factory=dict)          # track id -> (frames seen, peak confidence)
    alert_count: int = 0
    people: list = None            # set by the camera runner for a people crowd: every person box this frame, from the
                                   # region and its tiles (crowdcount.py), (x1, y1, x2, y2, confidence); counted instead of
                                   # the tracks, which miss people packed together
    _last_seconds: float = None
    _gap: float = 0.0

    @property
    def watch_points(self):
        return np.concatenate([z.points for z in self.zones])

    def breached(self, n):
        return n > self.limit

    def update(self, seconds, tracks):
        """Events: 'alert' when a zone has held more than the limit for the rule's time, and again every repeat time while it
        does; 'cleared' once it has been back under the limit. The alert carries `count`, `limit` and `box_px` (the zone)."""
        info, events = {}, []
        rule = self.rule
        counted = {}
        feet = {}                                  # gathering: zone id -> [(foot x, foot y, body height)]
        for track_id, x1, y1, x2, y2, confidence in tracks:
            track_id = int(track_id)
            frames, peak = self.seen.get(track_id, (0, 0.0))
            self.seen[track_id] = (frames + 1, max(peak, float(confidence)))
            confirmed = frames + 1 >= rule.min_frames and max(peak, float(confidence)) >= rule.min_confidence
            foot = _foot(x1, y1, x2, y2)
            zone = None
            for z in self.zones:
                if cv2.pointPolygonTest(z.points.astype(np.float32), (float(foot[0]), float(foot[1])), False) >= 0:
                    zone = z
                    if confirmed:
                        counted.setdefault(z.id, []).append(track_id)
                        feet.setdefault(z.id, []).append((float(x1 + x2) / 2, float(y1 + y2) / 2, float(y2 - y1)))
            info[track_id] = dict(zone=zone.id if zone else None, inside=zone is not None, flagged=False, moved=True, waiting=False)
        peaks = {}
        if self.people is not None:
            # A people crowd counts every person box the runner found this frame (tiles included), by their feet.
            counted, feet = {}, {}
            for x1, y1, x2, y2, confidence in self.people:
                foot = _foot(x1, y1, x2, y2)
                for z in self.zones:
                    if cv2.pointPolygonTest(z.points.astype(np.float32), (float(foot[0]), float(foot[1])), False) >= 0:
                        counted.setdefault(z.id, []).append(None)
                        feet.setdefault(z.id, []).append((float(x1 + x2) / 2, float(y1 + y2) / 2, float(y2 - y1)))
                        peaks[z.id] = max(peaks.get(z.id, 0.0), float(confidence))
        boxes = {}
        if self.kind == 'gathering':
            # What is counted is the biggest packed group in each zone, not everyone in it.
            for z in self.zones:
                size, box = biggest_group(feet.get(z.id, []), getattr(self, 'reach', GATHER_REACH))
                counted[z.id] = [None] * size
                boxes[z.id] = box
        if self._last_seconds is not None and seconds > self._last_seconds:
            self._gap = seconds - self._last_seconds
        self._last_seconds = seconds
        hold = max(CROWD_HOLD_SECONDS, 2.2 * self._gap)
        crowded = set()
        for z in self.zones:
            st = self.state.setdefault(z.id, _Crowd())
            st.counts = [(t, c) for t, c in st.counts if seconds - t < CROWD_WINDOW_SECONDS] + [(seconds, len(counted.get(z.id, [])))]
            n = int(round(float(np.median([c for _, c in st.counts]))))
            st.now = n
            if boxes.get(z.id) is not None:
                st.box = boxes[z.id]
            if self.breached(n):
                if st.over_since is None:
                    st.over_since = seconds
                st.last_over = seconds
            elif st.over_since is not None and seconds - st.last_over > hold:
                st.over_since = None
                if st.flagged:
                    st.flagged = False
                    events.append(dict(type='cleared', seconds=seconds, zone_id=z.id, zone_name=z.name))
            # The smoothed count decides that the zone is crowded; an alert also needs this frame's own count over the limit,
            # so the smoothing's lag never raises an alert just after the crowd has gone.
            if st.over_since is not None and seconds - st.over_since >= rule.dwell_seconds and self.breached(len(counted.get(z.id, []))):
                again = st.flagged and st.last_alert is not None and seconds - st.last_alert >= rule.repeat_seconds
                first = not st.flagged
                held_back = first and st.last_alert is not None and seconds - st.last_alert < rule.repeat_seconds
                st.flagged = True
                if held_back:
                    pass
                elif first or again:
                    st.alerts += 1
                    st.last_alert = seconds
                    self.alert_count += 1
                    x1, y1 = z.points.min(axis=0)
                    x2, y2 = z.points.max(axis=0)
                    if self.kind == 'gathering' and boxes.get(z.id) is not None:
                        x1, y1, x2, y2 = boxes[z.id]                      # the picture is boxed on the group, not the whole zone
                    # The alert says this frame's count, which is always over the limit here (the smoothed count lags behind it).
                    events.append(dict(type='alert', id=0, seconds=seconds, zone_id=z.id, zone_name=z.name,
                                       confidence=round(peaks[z.id] if z.id in peaks else max((self.seen[t][1] for t in counted.get(z.id, []) if t in self.seen), default=0.0), 3),
                                       reentry=st.alerts > 1, dwell=round(seconds - st.over_since, 2), frames=len(counted.get(z.id, [])), moved=0.0,
                                       count=len(counted.get(z.id, [])), limit=self.limit + (1 if self.kind == 'gathering' else 0), box_px=[float(x1), float(y1), float(x2), float(y2)]))
            if st.flagged:
                crowded.add(z.id)
        for track_id, state in info.items():
            state['flagged'] = state['zone'] in crowded
        if self.kind == 'gathering':
            # Only the people in the group are drawn as the alert, not everyone else in the zone.
            by_id = {int(t[0]): t for t in tracks}
            for track_id, state in info.items():
                box = self.state[state['zone']].box if state['zone'] in self.state else None
                t = by_id.get(track_id)
                if state['flagged'] and (box is None or t is None or not (box[0] <= _foot(*t[1:5])[0] <= box[2] and box[1] <= _foot(*t[1:5])[1] <= box[3])):
                    state['flagged'] = False
        for track_id in [t for t in self.seen if t not in info]:       # forget tracks that left, so the dict stays small
            del self.seen[track_id]
        return info, events


@dataclass
class GatheringRule(CrowdRule):
    """People packed together: alerts when the biggest group in a zone has at least `limit + 1` people (limit is one less, so
    the crowd rule's "more than" test serves both) and keeps that for the rule's time. Everything else is the crowd rule's:
    the smoothing over a few seconds, the repeat time, the person boxes from the region and its tiles."""
    kind: str = 'gathering'
    reach: float = GATHER_REACH


# ── a stopped vehicle ───────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class _Parked:
    origin: tuple = None            # where the track was first seen
    travelled: float = 0.0          # the furthest it has been from there, in pixels
    anchor: tuple = None
    since: float = 0.0
    frames: int = 0
    peak: float = 0.0
    flagged: bool = False
    last_alert: float = None
    alerts: int = 0
    last_seen: float = 0.0


@dataclass
class StoppedRule:
    zones: list
    rule: Rule
    scale: float = 1.0
    subject: str = 'vehicle'
    kind: str = 'stopped'
    state: dict = field(default_factory=dict)
    alert_count: int = 0
    suppressed_count: int = 0

    @property
    def watch_points(self):
        return np.concatenate([z.points for z in self.zones])

    def _zone(self, point):
        for z in self.zones:
            if cv2.pointPolygonTest(z.points.astype(np.float32), (float(point[0]), float(point[1])), False) >= 0:
                return z
        return None

    def update(self, seconds, tracks):
        """A track is stopped while its bottom centre stays within the rule's movement limit of where it was when it last
        moved. Events: 'alert' once it has been still long enough, 'suppressed' if the repeat time held it back, 'left' when a
        flagged vehicle moves off (or is not seen for a while)."""
        info, events = {}, []
        rule = self.rule
        wobble = max(rule.min_motion_px, 1.0) * self.scale
        for track_id, x1, y1, x2, y2, confidence in tracks:
            track_id = int(track_id)
            foot = _foot(x1, y1, x2, y2)
            zone = self._zone(foot)
            st = self.state.setdefault(track_id, _Parked())
            st.peak, st.last_seen = max(st.peak, float(confidence)), seconds
            if st.origin is None:
                st.origin = foot
            st.travelled = max(st.travelled, math.dist(foot, st.origin))
            if zone is None:
                if st.flagged:
                    st.flagged = False
                    events.append(dict(type='left', id=track_id, seconds=seconds))
                st.anchor = None
                info[track_id] = dict(zone=None, inside=False, flagged=False, moved=True, waiting=False)
                continue
            if st.anchor is None or math.dist(foot, st.anchor) > wobble:
                if st.flagged:
                    st.flagged = False
                    events.append(dict(type='left', id=track_id, seconds=seconds))
                st.anchor, st.since, st.frames = foot, seconds, 0
            st.frames += 1
            still_for = seconds - st.since
            ready = (still_for >= rule.dwell_seconds and st.frames >= rule.min_frames and st.peak >= rule.min_confidence
                     and st.travelled >= ARRIVE_PX * self.scale)
            again = (st.flagged and st.last_alert is not None and rule.repeat_seconds > 0
                     and seconds - st.last_alert >= rule.repeat_seconds)       # still there: say so again, like a fire that goes on
            if ready and (not st.flagged or again):
                first = not st.flagged
                st.flagged = True
                if first and st.last_alert is not None and seconds - st.last_alert < rule.repeat_seconds:
                    self.suppressed_count += 1
                    events.append(dict(type='suppressed', id=track_id, seconds=seconds, zone_id=zone.id, zone_name=zone.name))
                else:
                    st.alerts += 1
                    st.last_alert = seconds
                    self.alert_count += 1
                    events.append(dict(type='alert', id=track_id, seconds=seconds, zone_id=zone.id, zone_name=zone.name,
                                       confidence=round(st.peak, 3), reentry=st.alerts > 1, dwell=round(still_for, 2),
                                       frames=st.frames, moved=0.0, zone_pct=zone.points_pct))
            info[track_id] = dict(zone=zone.id, inside=True, flagged=st.flagged, moved=False, waiting=False)
        for track_id, st in list(self.state.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.state[track_id]
        return info, events


# ── vehicles: a small box-overlap tracker ───────────────────────────────────────────────────────────────────────────
def _iou(a, b):
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


@dataclass
class _VTrack:
    id: int
    box: tuple
    confidence: float
    hits: int = 1
    missed_since: float = None
    last_seen: float = 0.0


class VehicleTracker:
    """Follows vehicles from frame to frame by how much their boxes overlap. A parked or slow vehicle overlaps itself almost
    completely, which is all "stopped" needs; there is no re-identification and no motion model.

    A track is reported once it has been matched `min_hits` times (a one-frame ghost never gets an id) and is kept for
    `max_age` seconds after it is last seen, so a vehicle the detector misses for a moment keeps its id."""

    def __init__(self, min_iou=0.3, min_hits=2, max_age=2.0):
        self.min_iou, self.min_hits, self.max_age = min_iou, min_hits, max_age
        self.tracks, self.next_id = [], 1

    def update(self, seconds, detections):
        """detections: [(x1, y1, x2, y2, confidence)]. Returns [(id, x1, y1, x2, y2, confidence)] for the tracks seen now."""
        dets = sorted(((tuple(float(v) for v in d[:4]), float(d[4])) for d in detections), key=lambda d: -d[1])
        pairs = sorted(((_iou(t.box, box), ti, di) for ti, t in enumerate(self.tracks) for di, (box, _) in enumerate(dets)), reverse=True)
        used_t, used_d, seen = set(), set(), []
        for score, ti, di in pairs:
            if score < self.min_iou:
                break
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            t = self.tracks[ti]
            t.box, t.confidence, t.last_seen, t.hits = dets[di][0], dets[di][1], seconds, t.hits + 1
            seen.append(t)
        for di, (box, conf) in enumerate(dets):
            if di not in used_d:
                t = _VTrack(id=self.next_id, box=box, confidence=conf, last_seen=seconds)
                self.next_id += 1
                self.tracks.append(t)
                seen.append(t)
        self.tracks = [t for t in self.tracks if seconds - t.last_seen <= self.max_age]
        return [(t.id, *t.box, t.confidence) for t in seen if t.hits >= self.min_hits]


# ── building an engine from a console rule ──────────────────────────────────────────────────────────────────────────
def build_engine(rule, camera_zones, width, height):
    """The engine for one console rule on one camera, or None when there is nothing to watch (the zones it was set to use were
    deleted, or are the wrong shape for it). Raises ValueError for settings out of range."""
    kind = rule.get('condition', 'enters')
    settings = settings_for(rule)
    subject, scale = subject_of(rule), width / 1280
    wanted = set(rule.get('zoneIds') or [])
    chosen = [z for z in camera_zones if z['id'] in wanted] if wanted else [WHOLE_VIEW]
    if kind in ('crosses', 'wrongway', 'tailgate'):
        lines = lines_to_pixels(chosen, width, height) if wanted else []
        if not lines:
            return None
        from qavach import moverules
        if kind == 'wrongway':
            return moverules.WrongWayRule(lines, settings, rule['allowedDir'], scale=scale, subject=subject)
        if kind == 'tailgate':
            return moverules.TailgateRule(lines, settings, float(rule.get('gapSec') or 3.0), scale=scale, subject=subject)
        return LineRule(lines, settings, scale=scale, subject=subject)
    polygons = zones_to_pixels(chosen, width, height)
    if not polygons or (kind == 'outside' and not wanted):          # "outside" needs the allowed areas to be named
        return None
    if kind == 'outside':
        return OutsideRule(polygons, settings, scale=scale, subject=subject, kind=kind)
    if kind == 'down':
        from qavach.fallrule import CollapseRule
        return CollapseRule(polygons, settings, scale=scale)
    if kind in ('near', 'fewer', 'absent', 'speeding', 'running', 'abandoned', 'phone'):
        from qavach import moverules
        if kind == 'near':
            return moverules.NearRule(polygons, settings, float(rule.get('nearPx') or moverules.NEAR_PX), scale=scale,
                                      near_heights=float(rule['nearHeights']) if rule.get('nearHeights') else None,
                                      moving_only=rule.get('nearMovingOnly') is not False)
        if kind in ('fewer', 'absent'):
            return moverules.CountBelowRule(polygons, settings, limit=int(rule.get('minPeople') or 1) if kind == 'fewer' else 1,
                                            scale=scale, subject=subject, kind=kind, lone=kind == 'fewer')
        if kind == 'speeding':
            return moverules.SpeedingRule(polygons, settings, float(rule['speedKmh']), float(rule['metersAcross']) / width, scale=scale)
        if kind == 'running':
            return moverules.RunningRule(polygons, settings, float(rule.get('runSpeed') or moverules.RUN_BODY_HEIGHTS), scale=scale)
        if kind == 'abandoned':
            return moverules.AbandonedRule(polygons, settings, float(rule.get('ownerPx') or moverules.OWNER_PX), scale=scale)
        phone_conf = rule.get('phoneConfidence')
        return moverules.PhoneRule(polygons, settings, phone_confidence=moverules.PHONE_CONFIDENCE if phone_conf is None else float(phone_conf), scale=scale)
    if kind == 'crowd':
        return CrowdRule(polygons, settings, limit=int(rule['crowdOver']), scale=scale, subject=subject)
    if kind == 'gathering':
        return GatheringRule(polygons, settings, limit=int(rule['minPeople']) - 1, scale=scale, subject='person',
                             reach=float(rule.get('gatherReach') or GATHER_REACH))
    if kind == 'stopped':
        return StoppedRule(polygons, settings, scale=scale, subject=subject)
    return IntrusionRule(polygons, settings, scale=scale, subject=subject, kind=kind)
