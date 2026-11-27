"""The movement and relationship rules, on made-up tracks (no model, no camera)."""
import numpy as np
import pytest

from qavach.intrusion import Rule, ZonePx
from qavach.moverules import (OBJECT_ID_OFFSET, PHONE_ID_OFFSET, AbandonedRule, CountBelowRule, NearRule, PhoneRule, RunningRule,
                              SpeedingRule, TailgateRule, WrongWayRule)
from qavach.zonerules import VEHICLE_ID_OFFSET, LinePx, build_engine, settings_for

W, H = 1280, 720
V = VEHICLE_ID_OFFSET
FULL = ZonePx(id='z', name='Yard', points=np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.int32), points_pct=[[0, 0], [100, 0], [100, 100], [0, 100]])


def person(i, x, y, h=100, w=40, conf=0.9):
    """A person whose feet are at (x, y)."""
    return (i, x - w / 2, y - h, x + w / 2, y, conf)


def box(i, x, y, w, h, conf=0.9):
    return (i, x - w / 2, y - h, x + w / 2, y, conf)


def run(engine, frames, fps=5):
    alerts = []
    for k, tracks in enumerate(frames):
        _, events = engine.update(k / fps, tracks)
        alerts += [e for e in events if e['type'] == 'alert']
    return alerts


def rule(**kw):
    base = dict(dwell_seconds=0.0, min_frames=1, min_confidence=0.0, repeat_seconds=0.0)
    base.update(kw)
    return Rule(**base)


# ── near ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_person_near_moving_vehicle_alerts():
    engine = NearRule([FULL], rule(min_frames=2), near_px=80)
    frames = [[box(V + 1, 300 + 20 * k, 400, 200, 120), person(1, 450 + 20 * k, 400)] for k in range(15)]
    alerts = run(engine, frames)
    assert alerts and alerts[0]['id'] == 1 and alerts[0]['distance'] <= 80


def test_person_near_parked_vehicle_does_not_alert():
    engine = NearRule([FULL], rule(), near_px=80)
    frames = [[box(V + 1, 300, 400, 200, 120), person(1, 460, 400)] for _ in range(15)]
    assert run(engine, frames) == []


def test_person_far_from_moving_vehicle_does_not_alert():
    engine = NearRule([FULL], rule(), near_px=80)
    frames = [[box(V + 1, 200 + 20 * k, 400, 200, 120), person(1, 1100, 400)] for k in range(15)]
    assert run(engine, frames) == []


def _alongside(gap, h=100, vehicle_moving=True, new_id_each_frame=False, n=15):
    """A person (h px tall) and a vehicle (200 px wide) `gap` px from their side. The person shuffles or walks, so they are
    not a sign; the vehicle drives along with them (when moving) or stays put."""
    frames = []
    for k in range(n):
        px = 300 + (40 * k if vehicle_moving else 25 * (k % 3))
        vx = (px if vehicle_moving else 300) + 0.2 * h + 100 + gap
        vid = V + (k + 1 if new_id_each_frame else 1)
        frames.append([box(vid, vx, 400, 200, 120), person(1, px, 400, h=h, w=0.4 * h)])
    return frames


def test_near_is_measured_in_person_heights_so_it_means_the_same_on_every_camera():
    # a 100 px person: a vehicle 80 px away is 0.8 heights, 160 px away is 1.6
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.0), _alongside(80))
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.0), _alongside(160)) == []
    # a 20 px person (far from the camera) with a vehicle 50 px away is 2.5 heights: not near, though 50 px < the old 80 px
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.0), _alongside(50, h=20)) == []
    assert run(NearRule([FULL], rule(min_frames=2), near_px=80), _alongside(50, h=20))


def test_a_vehicle_that_is_moving_is_seen_even_when_the_tracker_gives_it_a_new_id_every_frame():
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.5), _alongside(0, new_id_each_frame=True))


def test_a_person_beside_a_parked_vehicle_alerts_only_when_parked_vehicles_count():
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.5), _alongside(0, vehicle_moving=False)) == []
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.5, moving_only=False), _alongside(0, vehicle_moving=False))


def test_a_sign_the_detector_calls_a_person_never_alerts():
    engine = NearRule([FULL], rule(min_frames=2), near_heights=1.5, moving_only=False)
    frames = [[box(V + 1, 480, 400, 200, 120), person(1, 300 + (k % 2), 400)] for k in range(40)]     # does not move
    assert run(engine, frames) == []


def test_the_console_settings_for_near_reach_the_engine():
    eng = build_engine(dict(condition='near', zoneIds=[], nearHeights=1.2, nearMovingOnly=False), [], W, H)
    assert eng.near_heights == 1.2 and eng.moving_only is False
    eng = build_engine(dict(condition='near', zoneIds=[]), [], W, H)
    assert eng.near_heights is None and eng.moving_only is True
    assert settings_for(dict(condition='near')).min_confidence == 0.45
    with pytest.raises(ValueError):
        settings_for(dict(condition='near', nearHeights=0))


# ── fewer / absent ──────────────────────────────────────────────────────────────────────────────────────────────────
def test_lone_worker_alerts_but_empty_zone_does_not():
    lone = CountBelowRule([FULL], rule(dwell_seconds=2.0), limit=2, kind='fewer', lone=True)
    assert run(lone, [[person(1, 500, 500)] for _ in range(20)])
    empty = CountBelowRule([FULL], rule(dwell_seconds=2.0), limit=2, kind='fewer', lone=True)
    assert run(empty, [[] for _ in range(20)]) == []


def test_team_of_two_does_not_alert():
    engine = CountBelowRule([FULL], rule(dwell_seconds=2.0), limit=2, kind='fewer', lone=True)
    assert run(engine, [[person(1, 500, 500), person(2, 600, 500)] for _ in range(20)]) == []


def test_empty_post_alerts():
    engine = CountBelowRule([FULL], rule(dwell_seconds=2.0), limit=1, kind='absent', lone=False)
    alerts = run(engine, [[] for _ in range(20)])
    assert alerts and alerts[0]['count'] == 0


# ── lines ───────────────────────────────────────────────────────────────────────────────────────────────────────────
LINE = LinePx(id='l', name='Gate', points=np.array([[640, 0], [640, 720]], dtype=np.float32))


def walk(i, x0, x1, n=10):
    return [[person(i, x0 + (x1 - x0) * k / (n - 1), 400)] for k in range(n)]


def test_wrong_way_alerts_only_against_allowed_direction():
    # Drawn top to bottom, moving left to right is to the left of the way drawn (y points down): direction -1.
    left_to_right = run(WrongWayRule([LINE], rule(min_frames=1), allowed=-1), walk(1, 500, 780))
    assert left_to_right == []
    right_to_left = run(WrongWayRule([LINE], rule(min_frames=1), allowed=-1), walk(1, 780, 500))
    assert len(right_to_left) == 1 and right_to_left[0]['direction'] == 1


def test_tailgate_second_person_within_gap_alerts():
    engine = TailgateRule([LINE], rule(min_frames=1), gap_seconds=3.0)
    frames = [a + b for a, b in zip(walk(1, 500, 780, 20), [[]] * 3 + walk(2, 500, 780, 17))]
    alerts = run(engine, frames)
    assert len(alerts) == 1 and alerts[0]['id'] == 2 and alerts[0]['other'] == 1


def test_tailgate_far_apart_does_not_alert():
    engine = TailgateRule([LINE], rule(min_frames=1), gap_seconds=1.0)
    frames = walk(1, 500, 780, 10) + [[]] * 30 + walk(2, 500, 780, 10)
    assert run(engine, frames) == []


# ── speed ───────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_speeding_uses_the_scale():
    # 40 px a frame at 5 fps = 200 px/s; picture 1280 px = 64 m, so 0.05 m/px = 10 m/s = 36 km/h
    fast = SpeedingRule([FULL], rule(min_frames=3), limit_kmh=30, metres_per_px=64 / W)
    frames = [[box(V + 1, 100 + 40 * k, 400, 150, 100)] for k in range(15)]
    alerts = run(fast, frames)
    assert alerts and 30 < alerts[0]['speed'] < 45
    slow = SpeedingRule([FULL], rule(min_frames=3), limit_kmh=50, metres_per_px=64 / W)
    assert run(slow, frames) == []


def test_parked_vehicle_is_not_speeding():
    engine = SpeedingRule([FULL], rule(min_frames=3), limit_kmh=5, metres_per_px=64 / W)
    assert run(engine, [[box(V + 1, 300, 400, 150, 100)] for _ in range(15)]) == []


# ── running ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_running_pace_is_in_body_heights():
    # 100 px tall person moving 40 px a frame at 5 fps = 2 body heights a second
    runner = RunningRule([FULL], rule(min_frames=3, dwell_seconds=0.5), body_heights=1.6)
    assert run(runner, [[person(1, 100 + 40 * k, 500)] for k in range(15)])
    walker = RunningRule([FULL], rule(min_frames=3, dwell_seconds=0.5), body_heights=1.6)
    assert run(walker, [[person(1, 100 + 15 * k, 500)] for k in range(15)]) == []


# ── left-behind object ──────────────────────────────────────────────────────────────────────────────────────────────
def test_object_left_by_a_person_alerts():
    engine = AbandonedRule([FULL], rule(dwell_seconds=3.0, min_frames=2), owner_px=150)
    bag = box(OBJECT_ID_OFFSET + 1, 600, 500, 50, 40)
    near_frames = [[bag, person(1, 640, 500)] for _ in range(5)]
    gone_frames = [[bag] for _ in range(30)]
    alerts = run(engine, near_frames + gone_frames)
    assert len(alerts) == 1 and alerts[0]['id'] == OBJECT_ID_OFFSET + 1


def test_object_with_its_owner_does_not_alert():
    engine = AbandonedRule([FULL], rule(dwell_seconds=3.0, min_frames=2), owner_px=150)
    bag = box(OBJECT_ID_OFFSET + 1, 600, 500, 50, 40)
    assert run(engine, [[bag, person(1, 640, 500)] for _ in range(40)]) == []


def test_object_never_near_anyone_does_not_alert():
    engine = AbandonedRule([FULL], rule(dwell_seconds=3.0, min_frames=2), owner_px=150)
    bag = box(OBJECT_ID_OFFSET + 1, 600, 500, 50, 40)
    assert run(engine, [[bag] for _ in range(40)]) == []


# ── phone ───────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_phone_in_the_hands_alerts_at_the_head_and_at_the_waist():
    p = person(1, 500, 500)
    for phone in [(PHONE_ID_OFFSET, 495, 420, 505, 440, 0.8), (PHONE_ID_OFFSET, 495, 470, 515, 490, 0.8)]:     # at the head, and low in the hands
        engine = PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2))
        assert run(engine, [[p, phone] for _ in range(15)])


def test_phone_far_from_the_person_does_not_alert():
    p = person(1, 500, 500)
    engine = PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2))
    assert run(engine, [[p, (PHONE_ID_OFFSET, 700, 460, 720, 480, 0.9)] for _ in range(15)]) == []          # beside them, well outside the box
    engine = PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2))
    assert run(engine, [[p, (PHONE_ID_OFFSET, 495, 520, 505, 540, 0.9)] for _ in range(15)]) == []          # on the ground below the feet


def test_phone_less_sure_than_the_setting_is_ignored():
    p = person(1, 500, 500)
    phone = (PHONE_ID_OFFSET, 495, 420, 505, 440, 0.30)         # what binoculars, cups and radios score
    assert run(PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2)), [[p, phone] for _ in range(15)]) == []       # default needs 0.35
    assert run(PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2), phone_confidence=0.25), [[p, phone] for _ in range(15)])
    assert run(PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2), phone_confidence=0.9), [[p, (PHONE_ID_OFFSET, 495, 420, 505, 440, 0.8)] for _ in range(15)]) == []


def test_phone_confidence_setting_reaches_the_engine_and_is_checked():
    zones = [dict(id='z1', name='Z', purpose='restricted', kind='polygon', points=[[0, 0], [100, 0], [100, 100], [0, 100]])]
    base = dict(id='R', condition='phone', subject='any', zoneIds=['z1'], mode='live')
    assert build_engine(base, zones, W, H).phone_confidence == 0.35
    assert build_engine(dict(base, phoneConfidence=0.6), zones, W, H).phone_confidence == 0.6
    with pytest.raises(ValueError):
        settings_for(dict(base, phoneConfidence=1.5))


# ── settings and building ───────────────────────────────────────────────────────────────────────────────────────────
def test_settings_need_their_extra_fields():
    with pytest.raises(ValueError):
        settings_for(dict(condition='speeding'))
    with pytest.raises(ValueError):
        settings_for(dict(condition='wrongway'))
    with pytest.raises(ValueError):
        settings_for(dict(condition='fewer', minPeople=1))
    settings_for(dict(condition='speeding', speedKmh=30, metersAcross=60))
    settings_for(dict(condition='fewer', minPeople=2))


def test_build_engine_for_each_new_condition():
    zones = [dict(id='z', name='Yard', purpose='restricted', kind='polygon', points=[[0, 0], [100, 0], [100, 100], [0, 100]]),
             dict(id='l', name='Gate', purpose='line', kind='line', points=[[50, 0], [50, 100]])]
    cases = dict(near=dict(), fewer=dict(minPeople=2), absent=dict(), running=dict(), abandoned=dict(), phone=dict(),
                 speeding=dict(speedKmh=30, metersAcross=60), wrongway=dict(allowedDir=1, zoneIds=['l']), tailgate=dict(zoneIds=['l']))
    for condition, extra in cases.items():
        r = dict(id='R', condition=condition, zoneIds=extra.pop('zoneIds', ['z']), **extra)
        engine = build_engine(r, zones, W, H)
        assert engine is not None and engine.kind == condition


def test_phone_in_zone_counts_when_feet_are_cut_off():
    """A person standing at the picture's bottom edge has their feet just outside a zone drawn short of the edge; a phone in the zone still counts."""
    zone = ZonePx(id='z', name='Z', points=np.array([[0, 0], [1000, 0], [1000, 700], [0, 700]], dtype=np.int32), points_pct=[[0, 0], [100, 0], [100, 97], [0, 97]])
    engine = PhoneRule([zone], rule(dwell_seconds=0, min_frames=1), 0.35)
    person = (1, 400, 300, 520, 720, 0.9)             # feet at y=720, outside the zone
    phone = (PHONE_ID_OFFSET + 5, 430, 450, 450, 470, 0.7)
    engine.update(1.0, [person, phone])                # one frame is not enough: a phone must be seen on two
    _, events = engine.update(1.2, [person, phone])
    assert events and events[0]['type'] == 'alert'


def test_zoom_boxes_only_small_people_and_merge_keeps_surer():
    import numpy as np
    from qavach import zoom
    boxes = zoom.zoom_boxes([(100, 100, 160, 300), (0, 0, 400, 700)], 1280, 720)     # the second person is taller than 55% of the picture
    assert len(boxes) == 1 and boxes[0][0] < 100 and boxes[0][2] > 160
    a = np.array([[10, 10, 30, 30, 0.3, 67]], dtype=np.float32)
    b = np.array([[11, 11, 31, 31, 0.6, 67], [200, 200, 220, 220, 0.5, 67]], dtype=np.float32)
    m = zoom.merge(a, b)
    assert len(m) == 2 and abs(float(m[0][4]) - 0.6) < 1e-6


def test_a_parked_vehicle_whose_box_wobbles_is_not_taken_for_a_moving_one():
    # a small parked car (40 px wide) whose box jumps 3 px back and forth each frame: 0.4 of its width a second over one frame
    frames = [[box(V + 1 + k, 300 + (3 if k % 2 else 0), 400, 40, 30), person(1, 300 + 30 * (k % 3) - 30, 400, h=60, w=24)] for k in range(20)]
    assert run(NearRule([FULL], rule(min_frames=2), near_heights=1.5), frames) == []


def test_a_parked_vehicle_missed_for_a_frame_is_not_matched_to_its_neighbour():
    # two parked cars side by side; the detector misses the one beside the person now and then, so on the next frame it is
    # nearest to where its neighbour was: one frame reads as fast driving, but a second earlier it stood just there
    frames = []
    for k in range(25):
        cars = [box(V + 1, 300, 400, 100, 60)] + ([] if k % 4 == 1 else [box(V + 2, 420, 400, 100, 60)])
        frames.append(cars + [person(1, 520 + 20 * (k % 3), 400, h=60, w=24)])
    assert run(NearRule([FULL], rule(min_frames=1), near_heights=1.5), frames) == []
