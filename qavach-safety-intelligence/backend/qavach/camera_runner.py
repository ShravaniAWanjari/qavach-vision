"""One running camera: keeps its stream open, finds and tracks people inside the drawn zones, applies the rules and
publishes a live preview plus alert events.

A camera with no usable rule still runs as a preview, so the video wall and the zone editor have a picture."""
import contextlib
import logging
import math
import threading
import time
import uuid
from collections import deque
from datetime import datetime

import cv2
import numpy as np

from qavach import clips, config, crowdcount, phonecues, scene, sources, zoom
from qavach.detector import TrackerClient
from qavach.fire import FireEngine, FireRule
from qavach.intrusion import Rule, zones_to_pixels
from qavach.moverules import (NEEDS, OBJECT_CLASSES, OBJECT_FLOOR, OBJECT_ID_OFFSET, PHONE_CLASS, PHONE_FLOOR, PHONE_ID_OFFSET, kind_of)
from qavach.zonerules import (CONDITIONS, OUTSIDE_ID, PERSON_CLASS, VEHICLE_CLASSES, VEHICLE_FLOOR, VEHICLE_ID_OFFSET, WHOLE_VIEW, VehicleTracker,
                              build_engine, settings_for)

RED, AMBER, GREY = (60, 60, 235), (30, 170, 245), (190, 190, 190)
FIRE_RED, FIRE_ORANGE = (60, 60, 235), (40, 150, 255)      # BGR: fire, smoke
STATIC = (200, 175, 130)        # in a zone, but not (yet) shown to be moving: a light, thin box with no label
# What the preview writes on a flagged track, by the rule that flagged it.
TRACK_LABELS = dict(enters='#{id}', dwells='#{id} dwell', outside='#{id} outside', crosses='#{id} crossed', stopped='stopped', crowd='', near='#{id} near vehicle',
                    fewer='', absent='', wrongway='#{id} wrong way', tailgate='#{id} tailgating', speeding='speeding', running='#{id} running',
                    abandoned='left behind', phone='#{id} phone', down='#{id} down')            # a crowd is marked by its red boxes: a word on each would bury the picture
STALL_SECONDS = 20          # a live stream that sends nothing for this long is treated as dropped
PHONE_POSE_SIZE = 320       # pose input for one person's crop (phone rule)
PHONE_POSE_PEOPLE = 4       # people a frame the phone rule runs pose on
PREVIEW_ONLY_FPS = 12       # preview rate of a camera that has no rule to run
BUFFER_SECONDS_BURSTY = 12  # YouTube and other HLS streams deliver several seconds of video at once: keep that much
BUFFER_SECONDS_STEADY = 3   # an RTSP camera delivers frame by frame: a few seconds covers a slow frame of the detector
BUFFER_FPS = PREVIEW_ONLY_FPS   # frames a second kept in the live buffer: above the 5 to 6 a second analysed in production
# The live picture is made only while someone is looking at it: a stream open in a browser, or a still asked for in the last few
# seconds. Box positions go out as data (the browser draws them), so no picture is drawn on here at all.
WATCH_SECONDS = 5.0
CLIP_FPS = 3                 # pictures a second kept for an alert clip of a live camera (24 kept: the last 8 seconds)
CLIP_WIDTH = 640             # their width when nobody is watching (a watched camera reuses the live picture)
STATES = ('seen', 'inside', 'waiting', 'flagged')
                                # and the preview rate of a camera without rules; the others are read past, not compressed


def schedule_active(schedule, now=None):
    """The rule editor's "When" setting. Night is 18:00 to 06:00 local time."""
    hour = (now or datetime.now()).hour
    if schedule == 'night':
        return hour >= 18 or hour < 6
    if schedule == 'day':
        return 6 <= hour < 18
    return True


def intrusion_rule(data):
    """The detection settings of a front-end rule as an intrusion Rule. Raises ValueError when out of range."""
    return Rule.from_dict(dict(dwell_seconds=data.get('durationSec'), min_frames=data.get('minFrames'),
                               min_confidence=data.get('minConfidence'), repeat_seconds=data.get('repeatSec'),
                               min_motion_px=data.get('minMovePx')))


def wants(subject, track_id):
    """Whether a rule about `subject` (person, vehicle or any) is fed this track: vehicle ids start at VEHICLE_ID_OFFSET."""
    return kind_of(track_id) in (('person', 'vehicle') if subject == 'any' else (subject,))


def _iou_box(a, b):
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def feeds(engine, track_id):
    """Whether an engine is fed this track. A rule that looks at people and something else (near, abandoned, phone) is fed every
    kind it needs; the others by their subject, where "any" is people and vehicles."""
    kind = kind_of(track_id)
    if engine.kind in NEEDS:
        return kind in NEEDS[engine.kind]
    return kind in (('person', 'vehicle') if engine.subject == 'any' else (engine.subject,))


def engine_needs(engine):
    """The kinds of thing the detectors must find for this engine: person, vehicle, object, phone."""
    if engine.kind in NEEDS:
        return set(NEEDS[engine.kind])
    return {'person', 'vehicle'} if engine.subject == 'any' else {engine.subject}


PERSON_TRACK_FLOOR = 0.05          # the tracker wants weak person boxes too (it links a person across frames with them)


def detect_floor(engines, needs):
    """The lowest confidence the person and vehicle detector needs to keep for a camera. People that are tracked need the
    weak boxes (0.05); a camera that only counts people, or only watches vehicles, objects and phones, uses nothing below its
    own floor, and the detector spends a lot less time cleaning up overlapping boxes without them."""
    floors = []
    if 'person' in needs:
        floors.append(PERSON_TRACK_FLOOR if needs_tracker(engines) else crowdcount.PERSON_FLOOR)
    if 'vehicle' in needs:
        floors.append(VEHICLE_FLOOR)
    if 'object' in needs:
        floors.append(OBJECT_FLOOR)
    if 'phone' in needs:
        floors.append(PHONE_FLOOR)
    return min(floors) if floors else PERSON_TRACK_FLOOR


def needs_tracker(engines):
    """Whether a camera's rules need the people tracker. A people crowd only needs a count, which the person boxes give (and
    the tracker's re-identification model costs seconds a frame on a CPU in a busy scene), so a camera whose only people rules
    are crowd rules runs without it."""
    people = [e for e, _ in engines if 'person' in engine_needs(e)]
    return bool(people) and not all(e.kind in ('crowd', 'gathering') and e.subject == 'person' for e in people)


def validate_rule(data):
    """Raises ValueError when a console rule's detection settings are out of range. Conditions without a detector are checked
    as far as the intrusion rule's settings go, so the console can keep saving them."""
    if is_fire(data):
        fire_rule(data)
    elif data.get('condition') in CONDITIONS:
        settings_for(data)
    else:
        intrusion_rule(data)


def detection_region(engines, width, height):
    """The part of the frame to run the detector on: the drawn zones (or lines) plus a margin, because people stand partly
    outside a zone (their head is above the feet that decide) and the tracker needs a little context. A rule that must see
    anywhere in the picture (someone outside the allowed areas) makes it the whole frame."""
    parts = [engine.watch_points for engine, _ in engines]
    if any(part is None for part in parts):
        return (0, 0, width, height)
    points = np.concatenate(parts)
    x1, y1 = points.min(axis=0)
    x2, y2 = points.max(axis=0)
    margin = int(0.15 * max(x2 - x1, y2 - y1)) + 48
    x1, y1, x2, y2 = x1 - margin, y1 - margin, x2 + margin, y2 + margin
    min_w, min_h = min(width, 320), min(height, 180)           # never a sliver the detector cannot use
    if x2 - x1 < min_w:
        x1, x2 = (x1 + x2 - min_w) / 2, (x1 + x2 + min_w) / 2
    if y2 - y1 < min_h:
        y1, y2 = (y1 + y2 - min_h) / 2, (y1 + y2 + min_h) / 2
    return (int(max(0, x1)), int(max(0, y1)), int(min(width, x2)), int(min(height, y2)))


def detect_size(region):
    long_side = max(region[2] - region[0], region[3] - region[1])
    return min(config.DETECT_SIZE, int(math.ceil(long_side / 32) * 32))


def fire_rule(data):
    """The detection settings of a front-end rule as a fire and smoke FireRule. Raises ValueError when out of range."""
    return FireRule.from_dict(dict(classes=data.get('fireClasses'), min_confidence=data.get('minConfidence'),
                                   min_hits=data.get('minFrames'), repeat_seconds=data.get('repeatSec')))


def bursty(source, address):
    """Whether a live source delivers video in bursts (YouTube, HLS over HTTP) rather than frame by frame (RTSP)."""
    a = str(address or '').lower()
    return source.kind == 'youtube' or '.m3u8' in a or a.startswith(('http://', 'https://'))


def is_fire(rule):
    return rule.get('condition') == 'smoke'


class LiveReader(threading.Thread):
    """Reads a live stream flat out into a short buffer of JPEG-compressed frames.

    Live streams (YouTube's HLS in particular) arrive in bursts, for example 150 frames at once every 5 seconds and
    nothing in between, so keeping only the newest frame would discard almost everything. The buffer holds the last
    few seconds and the processor picks frames from it evenly in stream time. Frames are compressed so a 4K camera
    does not need gigabytes of memory.

    It owns the capture and releases it itself when it stops: releasing a capture while another thread is inside
    read() crashes OpenCV's FFmpeg and takes the whole service down."""

    def __init__(self, capture, fps, keep_seconds=BUFFER_SECONDS_BURSTY, keep_fps=None, idle=None):
        super().__init__(daemon=True)
        self.capture = capture
        self.idle = idle            # () -> True while nothing needs the pictures: read past every frame without keeping it
        # Every frame is read (a stream must be read to move on), but only every `step`-th is kept: compressing all 25 a
        # second to JPEG cost most of the CPU spent on a live camera and held 165 MB a camera at 1080p for 12 seconds.
        self.step = max(1, round(fps / keep_fps)) if keep_fps else 1
        self.buffer = deque(maxlen=max(8, int(fps / self.step * keep_seconds)))      # (frame index, JPEG bytes)
        self.count = 0                                                      # frames read so far
        self.failed = False
        self.stop_flag = threading.Event()
        self.lock = threading.Lock()

    def run(self):
        try:
            while not self.stop_flag.is_set():
                if self.count % self.step or (self.idle is not None and self.idle()):     # not kept: read past it unconverted
                    if not self.capture.grab():
                        self.failed = True
                        return
                    with self.lock:
                        self.count += 1
                    continue
                ok, frame = self.capture.read()
                if not ok:
                    self.failed = True
                    return
                ok, data = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                with self.lock:
                    self.buffer.append((self.count, data.tobytes()))
                    self.count += 1
        finally:
            self.capture.release()

    def take(self, wanted):
        """The first buffered frame at or after index `wanted` as (index, jpeg), or None if it has not arrived yet.
        If `wanted` has already fallen out of the buffer, the oldest frame is returned."""
        with self.lock:
            for index, data in self.buffer:
                if index >= wanted:
                    return index, data
        return None


log = logging.getLogger('qavach.runner')


def _zones_box(engine, shape):
    """(x1, y1, x2, y2) in pixels around a rule's zones, or the whole picture when it has none."""
    height, width = shape[:2]
    try:
        points = engine.watch_points
    except ValueError:                                   # no zones: the whole view
        return 0, 0, width, height
    x1, y1 = np.floor(points.min(axis=0)).astype(int)
    x2, y2 = np.ceil(points.max(axis=0)).astype(int)
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(width, x2), min(height, y2)
    return (x1, y1, x2, y2) if x2 - x1 >= 8 and y2 - y1 >= 8 else (0, 0, width, height)


class CameraRunner:
    phone_scenes = None             # class default, so a runner built without __init__ (tools/try_rules.py) works too

    def __init__(self, camera, rules, get_detector, emit, get_fire_detector=None, get_pose_detector=None):
        """camera: dict(id, name, source, zones). rules: front-end rules this camera runs. get_detector: callable that
        returns the shared Detector. emit: called with each alert event dict."""
        self.camera, self.rules, self.get_detector, self.emit = camera, rules, get_detector, emit
        self.get_fire_detector = get_fire_detector
        self.get_pose_detector = get_pose_detector
        self.pose_detector = None        # loaded for cameras with a person-down rule
        # A video file restarts when it ends and a live stream restarts when it drops, with its clock back at zero. The
        # fire and smoke rule keeps its state across those restarts (so "don't repeat for" means what it says), and
        # `loop_offset` keeps the time it sees running forwards.
        self.fire_cache = None           # (frame size, engines)
        self.loop_offset = 0.0
        self.state = 'starting'          # starting | running | reconnecting | error | stopped
        self.error = None
        self.object_tracker = None      # the same kind of tracker for left-behind object candidates
        self.vehicle_tracker = None     # box-overlap tracker for vehicle rules (zonerules.VehicleTracker)
        self.detect_classes = (PERSON_CLASS,)
        self.phone_scenes = {}           # phone rule -> (scene.SceneWatch, phonecues.StaticLights)
        self.stats = dict(fps=0.0, source_fps=0.0, stream_fps=0.0, people=0, vehicles=0, hazards=0, frames=0, detecting=False, alerts=0, width=0, height=0)
        self.jpeg = None                 # the live picture (no boxes), made only while watched
        self.jpeg_overlay = None         # the boxes that go with that picture
        self.seq = 0
        self.overlay = None              # the boxes of the latest analysed frame (see overlay_of)
        self.overlay_seq = 0
        self.viewers = 0                 # live streams open in a browser
        self.wanted_until = 0.0          # a still was asked for: keep pictures coming until then
        self._clip_at = 0.0
        self.full = None                 # latest full-size frame
        self.full_at = 0.0
        self.file_pos = 0.0              # seconds into the video file for the frame being analysed
        self.recent = deque(maxlen=24)   # (JPEG, boxes) of the last moments, for the clip of a live camera
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_flag.set()
        self.thread.join(timeout=10)
        self.state = 'stopped'

    # ── who is looking ──────────────────────────────────────────────────────────────────────────────────────────
    def watched(self):
        return self.viewers > 0 or time.time() < self.wanted_until

    def want_frame(self):
        """A still was asked for: decode and keep the latest frame for the next few seconds, even on a camera with no rule."""
        self.wanted_until = max(self.wanted_until, time.time() + WATCH_SECONDS)

    @contextlib.contextmanager
    def watch(self):
        """While a live stream is open the camera makes its live picture."""
        self.viewers += 1
        try:
            yield
        finally:
            self.viewers -= 1

    # ── the outer loop: connect, run, and start again when the stream drops or a file ends ──────────────────────
    def _run(self):
        backoff = 2.0
        while not self.stop_flag.is_set():
            started = time.time()
            try:
                self._session()
                backoff = 2.0
                if time.time() - started < 1.0:
                    self.stop_flag.wait(1.0)            # a file that ends at once must not spin
            except Exception as error:      # shown to the user next to the camera; the loop keeps trying
                text = str(error) or type(error).__name__
                self.error = text if isinstance(error, (sources.SourceError, FileNotFoundError)) else f'{type(error).__name__}: {text}'
                self.state = 'reconnecting' if self.camera['source'].live else 'error'
                print(f'camera {self.camera["id"]}: {self.error}', flush=True)
                if self.stop_flag.wait(backoff):
                    break
                backoff = min(30.0, backoff * 2)

    def _build_engines(self, width, height):
        """One engine per people or vehicle rule (enters, dwells, outside, crosses, crowd, stopped). A rule with nothing to
        watch (its zones were deleted, or are the wrong shape for it) has no engine."""
        engines = []
        for rule in self.rules:
            if is_fire(rule) or rule.get('condition', 'enters') not in CONDITIONS:
                continue
            engine = build_engine(rule, self.camera['zones'], width, height)
            if engine is not None:
                engines.append((engine, rule))
        return engines

    def _prepare(self, engines):
        """Set up what the engines need beyond the people tracker: the vehicle and object trackers and the classes to detect.
        Returns the kinds needed (person, vehicle, object, phone)."""
        needs = set().union(*(engine_needs(e) for e, _ in engines)) if engines else set()
        self.vehicle_tracker = VehicleTracker() if 'vehicle' in needs else None
        self.object_tracker = VehicleTracker(min_hits=3) if 'object' in needs else None
        self.detect_classes = (((PERSON_CLASS,) if 'person' in needs else ()) + (VEHICLE_CLASSES if 'vehicle' in needs else ())
                               + (OBJECT_CLASSES if 'object' in needs else ()) + ((PHONE_CLASS,) if 'phone' in needs else ()))
        self.detect_floor = detect_floor(engines, needs)
        return needs

    def _poses(self, crop, tracks, region):
        """{track id: 17x3 keypoints} for the tracked people the pose model also found (boxes overlapping by at least 0.3)."""
        found = self.pose_detector.detect(crop, detect_size(region))
        poses = {}
        for t in tracks:
            best = max(((_iou_box(t[:4], box), kp) for box, kp in found), key=lambda x: x[0], default=(0.0, None))
            if best[0] >= 0.3:
                poses[int(t[4])] = best[1]
        return poses

    def _build_fire_engines(self, width, height):
        """One engine per fire and smoke rule. Its watch areas are the camera's fire-watch zones the rule picked (none
        picked: the whole view); the camera's fire-ignore zones always apply, because they mark known false sources."""
        engines = []
        zones = self.camera['zones']
        ignore = zones_to_pixels([z for z in zones if z.get('purpose') == 'fire-ignore'], width, height)
        for rule in self.rules:
            if not is_fire(rule):
                continue
            wanted = set(rule.get('zoneIds') or [])
            watch = zones_to_pixels([z for z in zones if z['id'] in wanted and z.get('purpose') == 'fire-watch'], width, height)
            if wanted and not watch:        # the areas it was set to watch were deleted or are not areas: nothing to watch
                continue
            engines.append((FireEngine(fire_rule(rule), watch, ignore), rule))
        return engines

    def _session(self):
        source = self.camera['source']
        address, _ = sources.stream_address(source)
        capture = sources.open_capture(address)
        fps = capture.get(cv2.CAP_PROP_FPS) or 0
        fps = fps if 1 <= fps <= 120 else 25.0
        width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        engines = self._build_engines(width, height)
        if self.fire_cache is None or self.fire_cache[0] != (width, height):
            self.fire_cache = ((width, height), self._build_fire_engines(width, height))
        fire_engines = self.fire_cache[1]
        tracker = detector = region = fire_detector = None
        reader = None
        last_seconds = 0.0
        try:
            if engines:
                detector = self.get_detector()
                needs = self._prepare(engines)
                if 'person' in needs and needs_tracker(engines):
                    tracker = TrackerClient()
                    tracker.reset(fps)
                self.pose_detector = self.get_pose_detector() if 'pose' in needs else None
                region = detection_region(engines, width, height)
            if fire_engines:
                fire_detector = self.get_fire_detector()
            self.stats.update(source_fps=round(fps, 1), width=width, height=height, detecting=bool(engines or fire_engines))
            self.state, self.error = 'running', None
            if source.live:
                reader = LiveReader(capture, fps, keep_seconds=BUFFER_SECONDS_BURSTY if bursty(source, address) else BUFFER_SECONDS_STEADY,
                                    keep_fps=BUFFER_FPS, idle=lambda: not self.stats['detecting'] and not self.watched())
                reader.start()
            done, busy, opened = 0, 0.0, time.time()
            for frame, seconds in (self._live_frames(reader, fps) if reader else self._file_frames(capture, fps, bool(engines or fire_engines), self.camera['source'].every_frame)):
                tick = time.time()
                last_seconds = seconds
                self.file_pos = seconds
                rows, fires = self._process(frame, seconds, engines, tracker, detector, region, width, height, fire_engines, fire_detector)
                done += 1
                busy += time.time() - tick
                self.stats.update(fps=round(done / max(busy, 1e-6), 1), people=sum(1 for r in rows if kind_of(r[0]) == 'person'),
                                  vehicles=sum(1 for r in rows if kind_of(r[0]) == 'vehicle'),
                                  hazards=sum(1 for f in fires if f[3] == 'counted'), frames=self.stats['frames'] + 1,
                                  **({} if reader else dict(position=round(seconds, 1))))     # a video file: seconds into the file
                if reader:      # how fast the stream itself delivers, to tell a slow stream from a slow detector
                    self.stats['stream_fps'] = round(reader.count / max(time.time() - opened, 1e-6), 1)
        finally:
            self.loop_offset += last_seconds + 1.0 / fps
            if reader:
                reader.stop_flag.set()          # the reader releases the capture when its current read returns
            else:
                capture.release()
            if tracker:
                tracker.close()

    # ── frame sources ───────────────────────────────────────────────────────────────────────────────────────────
    def _file_frames(self, capture, fps, detecting, every_frame=False):
        """A video file plays in real time, like a camera that is always on; frames are skipped when the detector
        falls behind. With `every_frame` nothing is skipped: each frame is analysed in order, so the video plays slower
        than real time when the detector cannot keep up (and never faster than real time). Times stay the video's own
        either way. The caller starts it again when the file ends, with fresh tracking."""
        started, number, skipped, total = time.time(), 0, False, None
        while not self.stop_flag.is_set():
            if not detecting and not self.watched():
                # A camera with no rule and nobody watching: the video's clock runs on without reading the file at all,
                # and reading starts again at the right place when someone looks.
                self.stop_flag.wait(0.1)
                number = int((time.time() - started) * fps)
                if total is None:
                    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
                if total and number >= total:
                    return
                skipped = True
                continue
            if skipped:
                capture.set(cv2.CAP_PROP_POS_FRAMES, number)
                skipped = False
            if not every_frame and time.time() - (started + number / fps) > 1.5 / fps:
                if not capture.grab():
                    return
                number += 1
                continue
            ok, frame = capture.read()
            if not ok:
                return
            yield frame, number / fps
            number += 1
            self.stop_flag.wait(max(0.0, started + number / fps - time.time()))   # never ahead of real time; no wait when behind

    def _live_frames(self, reader, fps):
        """Frames of a live stream, spaced evenly in stream time at whatever rate the detector can sustain. The time
        of a frame is its position in the stream (index / fps), not when it happened to arrive, so a rule's seconds
        mean video seconds even though the stream delivers in bursts."""
        wanted, last_count, last_new = 0, 0, time.time()
        while not self.stop_flag.is_set():
            if reader.count != last_count:
                last_count, last_new = reader.count, time.time()
            if not self.stats['detecting'] and not self.watched():
                wanted = reader.count               # a camera with no rule and nobody watching: nothing to decode
                if reader.failed:
                    raise sources.SourceError('The stream stopped; reconnecting')
                if time.time() - last_new > STALL_SECONDS:
                    raise sources.SourceError('The stream sent nothing for 20 seconds; reconnecting')
                self.stop_flag.wait(0.1)
                continue
            got = reader.take(wanted)
            if got is None:
                if reader.failed:
                    raise sources.SourceError('The stream stopped; reconnecting')
                if time.time() - last_new > STALL_SECONDS:
                    raise sources.SourceError('The stream sent nothing for 20 seconds; reconnecting')
                self.stop_flag.wait(0.005)
                continue
            index, data = got
            began = time.time()
            frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            yield frame, index / fps
            # Skip the frames that went by while this one was being worked on, so the work keeps up with the stream.
            floor = 1 if self.stats['detecting'] else math.ceil(fps / PREVIEW_ONLY_FPS)
            wanted = index + max(floor, math.ceil((time.time() - began) * fps))

    # ── per frame ───────────────────────────────────────────────────────────────────────────────────────────────
    def _process(self, frame, seconds, engines, tracker, detector, region, width, height, fire_engines=(), fire_detector=None):
        self.full, self.full_at = frame, time.time()
        rows, flagged, inside, waiting, labels = [], set(), set(), set(), {}
        if engines:
            x1, y1, x2, y2 = region
            crop = np.ascontiguousarray(frame[y1:y2, x1:x2])
            found = detector.detect(crop, detect_size(region), self.detect_classes, conf=getattr(self, 'detect_floor', PERSON_TRACK_FLOOR))
            if tracker is not None:
                tracks = tracker.update(crop, found[found[:, 5] == PERSON_CLASS])
                rows = [(int(t[4]), float(t[0]) + x1, float(t[1]) + y1, float(t[2]) + x1, float(t[3]) + y1, float(t[5]))
                        for t in tracks]       # plain floats: they end up in the JSON alert events
                if self.pose_detector is not None and any(e.kind == 'down' for e, _ in engines):
                    poses = self._poses(crop, tracks, region)
                    for engine, _ in engines:
                        if engine.kind == 'down':
                            engine.pose = poses
            if self.vehicle_tracker is not None:
                cars = found[np.isin(found[:, 5], VEHICLE_CLASSES) & (found[:, 4] >= VEHICLE_FLOOR)]
                rows += [(VEHICLE_ID_OFFSET + t[0], float(t[1]) + x1, float(t[2]) + y1, float(t[3]) + x1, float(t[4]) + y1, float(t[5]))
                         for t in self.vehicle_tracker.update(seconds, cars[:, :5])]
            if self.object_tracker is not None:
                things = found[np.isin(found[:, 5], OBJECT_CLASSES) & (found[:, 4] >= OBJECT_FLOOR)]
                rows += [(OBJECT_ID_OFFSET + t[0], float(t[1]) + x1, float(t[2]) + y1, float(t[3]) + x1, float(t[4]) + y1, float(t[5]))
                         for t in self.object_tracker.update(seconds, things[:, :5])]
            if PHONE_CLASS in self.detect_classes:
                phones = found[(found[:, 5] == PHONE_CLASS) & (found[:, 4] >= PHONE_FLOOR)].copy()
                phones[:, [0, 2]] += x1                 # into picture pixels, like the person rows
                phones[:, [1, 3]] += y1
                # A phone is tiny in a wide view: look again, enlarged, at each person who is small in the picture.
                people = [r[1:5] for r in rows if r[0] < VEHICLE_ID_OFFSET]
                if people:
                    seen = zoom.zoom_phones(detector, frame, people)
                    phones = zoom.merge(phones, seen[seen[:, 4] >= PHONE_FLOOR])
                rows += [(PHONE_ID_OFFSET + i, float(p[0]), float(p[1]), float(p[2]), float(p[3]), float(p[4])) for i, p in enumerate(phones)]
                self._phone_cues(frame, rows, engines)
            # A people crowd is counted from every person box, the region's and the small ones its tiles find, not only from
            # the tracks: people packed together are missed by the tracker's detector pass.
            whole = None
            for engine, _ in engines:
                if engine.kind in ('crowd', 'gathering') and engine.subject == 'person':
                    if whole is None:
                        whole = found[found[:, 5] == PERSON_CLASS].copy()
                        whole[:, [0, 2]] += x1
                        whole[:, [1, 3]] += y1
                    engine.people = crowdcount.people_boxes(detector, frame, _zones_box(engine, frame.shape), whole)
                    if tracker is None:
                        # No tracker on a crowd-only camera: the counted people are the preview's boxes (numbered per frame).
                        known = {tuple(round(v) for v in r[1:5]) for r in rows}
                        for b in engine.people:
                            if tuple(round(v) for v in b[:4]) not in known:
                                known.add(tuple(round(v) for v in b[:4]))
                                rows.append((len(rows) + 1, *b[:5]))
            now = datetime.now()
            for engine, rule in engines:
                if not schedule_active(rule.get('schedule', 'always'), now):
                    continue
                info, events = engine.update(seconds, [r for r in rows if feeds(engine, r[0])])
                for track_id, state in info.items():
                    if state['flagged']:
                        flagged.add(track_id)
                        labels.setdefault(track_id, engine.kind)
                    elif state['inside']:
                        inside.add(track_id)
                    if state['waiting']:
                        waiting.add(track_id)
                for event in events:
                    if event['type'] == 'alert':
                        self._alert(frame, rows, rule, engine, event, width, height)
        fires = self._process_fire(frame, seconds + self.loop_offset, fire_engines, fire_detector, width, height)
        notes = []
        for engine, _ in engines:
            if engine.kind in ('crowd', 'gathering'):
                for z in engine.zones:
                    st = engine.state.get(z.id)
                    if st is not None:
                        x, y = z.points[:, 0].min(), z.points[:, 1].max()   # bottom left: the zone's name is at its top
                        word = 'people' if engine.subject == 'person' else 'vehicles'
                        text = (f'group of {st.now} (alert at {engine.limit + 1})' if engine.kind == 'gathering'
                                else f'{st.now} / {engine.limit} {word}')
                        notes.append((float(x), float(y), text, RED if st.flagged else AMBER))
        self._publish(frame, seconds, overlay_of(frame, seconds, rows, flagged, inside, waiting - flagged, fires, labels, notes))
        return rows, fires

    def _person_pose(self, frame, box):
        """17 keypoints in picture pixels for the person in `box`, from the pose model run on that person alone (a padded crop
        at PHONE_POSE_SIZE pixels: several times cheaper than the whole picture on a CPU), or None."""
        height, width = frame.shape[:2]
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        cx1, cy1 = int(max(0, x1 - 0.15 * w)), int(max(0, y1 - 0.1 * h))
        cx2, cy2 = int(min(width, x2 + 0.15 * w)), int(min(height, y2 + 0.05 * h))
        if cx2 - cx1 < 8 or cy2 - cy1 < 16:
            return None
        found = self.pose_detector.detect(np.ascontiguousarray(frame[cy1:cy2, cx1:cx2]), PHONE_POSE_SIZE)
        if not found:
            return None
        # the pose whose box best covers the tracked person (another person can stand partly inside the crop)
        target = (x1 - cx1, y1 - cy1, x2 - cx1, y2 - cy1)
        score, kp = max(((_iou_box(target, b), k) for b, k in found), key=lambda x: x[0])
        if score < 0.3:
            return None
        kp = np.asarray(kp, dtype=np.float32).copy()
        kp[:, 0] += cx1
        kp[:, 1] += cy1
        return kp

    def _phone_cues(self, frame, rows, engines):
        """Give each phone rule its scene mode and, for each person inside its zones, their posture and the lights at their
        hands (lights only at night). The scene is measured on the area of the rule's zones, on the first frame and then every
        scene.CHECK_EVERY frames; the map of lamps and lit windows is refreshed at the same time. Pose runs only on people
        inside a phone rule's zones, at most PHONE_POSE_PEOPLE a frame (the largest first)."""
        if self.phone_scenes is None:
            self.phone_scenes = {}
        people = sorted((r for r in rows if kind_of(int(r[0])) == 'person'), key=lambda r: -(r[4] - r[2]))
        poses, posed = {}, 0
        for engine, _ in engines:
            if engine.kind != 'phone':
                continue
            watch, static = self.phone_scenes.setdefault(id(engine), (scene.SceneWatch(), phonecues.StaticLights()))
            due = watch.due()
            area = _zones_box(engine, frame.shape)
            mode = watch.update(lambda: frame[area[1]:area[3], area[0]:area[2]])
            if due:
                static.update(frame, [r[1:5] for r in people])
            engine.scene = mode
            cues = {}
            for r in people:
                box = r[1:5]
                if engine.in_zone(box) is None:
                    continue
                tid = int(r[0])
                if tid not in poses and self.pose_detector is not None and posed < PHONE_POSE_PEOPLE:
                    poses[tid] = self._person_pose(frame, box)
                    posed += 1
                kp = poses.get(tid)
                lights = phonecues.glow(frame, box, kp, static) if mode and mode.startswith('night') else []
                cues[int(r[0])] = (phonecues.posture(kp, box), lights, *phonecues.hands(kp, box))
            engine.cues = cues
            self.stats.update(scene=mode, sceneChecks=watch.checks)

    def _process_fire(self, frame, seconds, fire_engines, fire_detector, width, height):
        """Run the fire and smoke detector once on the frame and give every fire rule its detections. Returns
        (class, confidence, box, status) for the preview, where status is 'counted' for a detection that counts for at
        least one rule and 'ignored' for one that counts for none."""
        if not fire_engines:
            return []
        detections = fire_detector.detect(frame)
        counted = [False] * len(detections)
        now = datetime.now()
        for engine, rule in fire_engines:
            if not schedule_active(rule.get('schedule', 'always'), now):
                continue
            info, events = engine.update(seconds, detections)
            for i, status in enumerate(info):
                counted[i] = counted[i] or status == 'counted'
            for event in events:
                if event['type'] == 'alert':
                    self._fire_alert(frame, rule, event, width, height)
        return [(name, conf, box, 'counted' if ok else 'ignored') for (name, conf, box), ok in zip(detections, counted)]

    def _clip(self, event_id):
        """Save a short clip of this moment; returns its address, or None when it could not be made."""
        source = self.camera['source']
        try:
            if source.kind == 'upload':
                made = clips.from_file(sources.upload_path(source.upload_id), self.file_pos, event_id)
            else:
                made = clips.from_frames([annotate(data, overlay) for data, overlay in list(self.recent)], event_id, fps=CLIP_FPS)
        except Exception as error:      # a clip is a bonus: the alert goes out without one
            print(f'clip {event_id}: {error}', flush=True)
            made = False
        return f'/api/clips/{event_id}.mp4' if made else None

    def _fire_alert(self, frame, rule, event, width, height):
        x1, y1, x2, y2 = event['box']
        event_id = f'EV-{uuid.uuid4().hex[:8]}'
        config.SNAPSHOTS.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(config.SNAPSHOTS / f'{event_id}.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
        self.stats['alerts'] += 1
        clip = self._clip(event_id)
        self.emit(dict(
            clip=clip, id=event_id, at=int(time.time() * 1000), cameraId=self.camera['id'], ruleId=rule['id'], condition='smoke',
            zoneId=event['zone_id'], zoneName=event['zone_name'] or WHOLE_VIEW['name'], hazard=event['hazard'],
            trackId=0, confidence=event['confidence'], dwell=event['dwell'], frames=event['frames'],
            reentry=event['repeat'], moved=0.0, mode=rule.get('mode', 'test'),
            box=[round(100 * x1 / width, 1), round(100 * y1 / height, 1), round(100 * (x2 - x1) / width, 1),
                 round(100 * (y2 - y1) / height, 1)]))

    def _alert(self, frame, rows, rule, engine, event, width, height):
        """Save the picture and clip of an alert and publish it. A track's alert is boxed on the track; a crowd's on its zone."""
        row = next((r for r in rows if r[0] == event['id']), None)
        if 'box_px' in event:
            x1, y1, x2, y2 = event['box_px']
        elif row is None:
            return
        else:
            _, x1, y1, x2, y2, _ = row
        event_id = f'EV-{uuid.uuid4().hex[:8]}'
        config.SNAPSHOTS.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(config.SNAPSHOTS / f'{event_id}.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
        self.stats['alerts'] += 1
        clip = self._clip(event_id)
        subject = kind_of(event['id']) if event['id'] else engine.subject
        extra = {k: event[k] for k in ('count', 'limit', 'direction', 'speed', 'distance', 'gap', 'other', 'level', 'cue', 'scene') if k in event}
        self.emit(dict(
            clip=clip, id=event_id, at=int(time.time() * 1000), cameraId=self.camera['id'], ruleId=rule['id'],
            condition=engine.kind, subject=subject,
            zoneId=None if event['zone_id'] in (WHOLE_VIEW['id'], OUTSIDE_ID) else event['zone_id'], zoneName=event['zone_name'],
            trackId=event['id'] % VEHICLE_ID_OFFSET, confidence=event['confidence'], dwell=event['dwell'], frames=event['frames'],
            reentry=event['reentry'], moved=event['moved'], mode=rule.get('mode', 'test'), **extra,
            box=[round(100 * x1 / width, 1), round(100 * y1 / height, 1), round(100 * (x2 - x1) / width, 1),
                 round(100 * (y2 - y1) / height, 1)]))

    @staticmethod
    def _label(view, text, box_top_left, colour):
        """Small text with a dark outline, so it stays readable on a bright sky or a white road marking. It sits above the
        box; when the box starts at the top of the picture it goes just inside the box, and it never runs off an edge."""
        height, width = view.shape[:2]
        (text_w, text_h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        x = max(3, min(box_top_left[0], width - text_w - 4))
        y = box_top_left[1] - 5 if box_top_left[1] - 5 >= text_h + 3 else box_top_left[1] + text_h + 6
        y = max(text_h + 3, min(y, height - 4))
        cv2.putText(view, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(view, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)

    def _publish(self, frame, seconds, overlay):
        """Hands out what this frame found. The boxes always (as data, for the browser to draw over the picture); the live
        picture only while someone watches; and, on a live camera with rules, a small picture a few times a second for the
        clip of an alert (the boxes are drawn on those only when a clip is made)."""
        overlay['seq'] = self.overlay_seq = self.overlay_seq + 1
        self.overlay = overlay
        watched = self.watched()
        if watched:
            height, width = frame.shape[:2]
            scale = min(1.0, config.PREVIEW_WIDTH / width)
            view = cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else frame
            ok, buffer = cv2.imencode('.jpg', view, [cv2.IMWRITE_JPEG_QUALITY, 72])
            self.jpeg, self.jpeg_overlay = buffer.tobytes(), overlay
            self.seq += 1
        now = time.time()
        if self.camera['source'].live and self.stats.get('detecting') and now - self._clip_at >= 1.0 / CLIP_FPS:
            self._clip_at = now
            if watched:
                data = self.jpeg
            else:
                height, width = frame.shape[:2]
                scale = min(1.0, CLIP_WIDTH / width)
                small = cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_LINEAR) if scale < 1 else frame
                data = cv2.imencode('.jpg', small, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()
            self.recent.append((data, overlay))

    def snapshot(self, width=None):
        """JPEG bytes of the latest frame (full size, or at most `width` pixels wide for a thumbnail), or None before the first one."""
        frame = self.full
        if frame is None:
            return None
        if width and frame.shape[1] > width:
            scale = width / frame.shape[1]
            frame = cv2.resize(frame, (int(width), int(frame.shape[0] * scale)), interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 88 if width is None else 80])
        return buffer.tobytes()


# ── boxes as data ──────────────────────────────────────────────────────────────────────────────────────────────────
def overlay_of(frame, seconds, rows, flagged, inside, waiting=frozenset(), fires=(), labels=None, notes=()):
    """What one analysed frame found, as data the browser draws over the picture: positions are fractions of the
    picture (0 to 1), so they fit a picture of any size. `t` is the frame's time in the video (seconds into a file), so a
    browser playing the file itself can show each set of boxes on the frame it belongs to.
      boxes  [x1, y1, x2, y2, state, label]   state: flagged (alert), waiting (in a zone, not moving yet), inside, seen
      fires  [x1, y1, x2, y2, kind, label]     kind: fire, smoke or ignored (outside the watch areas)
      notes  [x, y, text, level]               a crowd zone's count against its limit; level: alert or warn"""
    height, width = frame.shape[:2]
    r = lambda v, size: round(min(1.0, max(0.0, v / size)), 4)
    boxes = []
    for track_id, x1, y1, x2, y2, _ in rows:
        state = 'flagged' if track_id in flagged else 'waiting' if track_id in waiting else 'inside' if track_id in inside else 'seen'
        text = TRACK_LABELS.get((labels or {}).get(track_id), '#{id}').format(id=track_id % VEHICLE_ID_OFFSET) if state == 'flagged' else ''
        boxes.append([r(x1, width), r(y1, height), r(x2, width), r(y2, height), state, text])
    fire_list = [[r(x1, width), r(y1, height), r(x2, width), r(y2, height), name if status != 'ignored' else 'ignored',
                  f'{name.upper()} {int(conf * 100)}%' if status != 'ignored' else '']
                 for name, conf, (x1, y1, x2, y2), status in fires]
    note_list = [[r(x, width), r(y, height), text, 'alert' if colour == RED else 'warn'] for x, y, text, colour in notes]
    return dict(t=round(float(seconds), 3), w=int(width), h=int(height), boxes=boxes, fires=fire_list, notes=note_list)


_STATE_COLOUR = dict(flagged=RED, waiting=STATIC, inside=AMBER, seen=GREY)
_FIRE_COLOUR = dict(fire=FIRE_RED, smoke=FIRE_ORANGE, ignored=GREY)


def draw_overlay(view, overlay):
    """Draws an overlay's boxes onto a picture of any size (used for alert clips; the live view draws in the browser)."""
    height, width = view.shape[:2]
    for x1, y1, x2, y2, state, text in overlay['boxes']:
        p1, p2 = (int(x1 * width) - 2, int(y1 * height) - 2), (int(x2 * width) + 2, int(y2 * height) + 2)
        colour = _STATE_COLOUR[state]
        cv2.rectangle(view, p1, p2, colour, 2 if state == 'flagged' else 1)
        if text:
            CameraRunner._label(view, text, p1, colour)
    for x1, y1, x2, y2, kind, text in overlay['fires']:
        p1, p2 = (int(x1 * width), int(y1 * height)), (int(x2 * width), int(y2 * height))
        cv2.rectangle(view, p1, p2, _FIRE_COLOUR[kind], 1 if kind == 'ignored' else 2)
        if text:
            CameraRunner._label(view, text, p1, _FIRE_COLOUR[kind])
    for x, y, text, level in overlay['notes']:
        CameraRunner._label(view, text, (int(x * width) + 6, int(y * height) - 4), RED if level == 'alert' else AMBER)
    return view


def annotate(jpeg, overlay):
    """A kept picture with its boxes drawn on, for a clip."""
    view = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if view is None:
        return jpeg
    return cv2.imencode('.jpg', draw_overlay(view, overlay), [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
