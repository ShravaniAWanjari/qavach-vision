import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qavach.intrusion import IntrusionRule, Rule, zones_to_pixels
from qavach.zonerules import (CrowdRule, LineRule, OutsideRule, StoppedRule, VehicleTracker, build_engine, distance_to_segment,
                              lines_to_pixels, segments_cross, settings_for, subject_of)

W, H = 1000, 1000
FPS = 10.0
AREA = dict(id='a1', name='Walkway', kind='polygon', points=[[40, 40], [90, 40], [90, 90], [40, 90]])     # % of frame: x, y 400..900
LINE = dict(id='l1', name='Gate line', kind='line', points=[[50, 0], [50, 100]])                           # vertical at x=500
BENT = dict(id='l2', name='Bent line', kind='line', points=[[20, 50], [50, 50], [50, 90]])


def box(x, y, conf=0.9, h=60, w=20, track=7):
    """A track whose feet (bottom centre) are at (x, y) pixels."""
    return (track, x - w / 2, y - h, x + w / 2, y, conf)


def run(engine, frames, fps=FPS):
    events = []
    for i, tracks in enumerate(frames):
        info, found = engine.update(i / fps, tracks)
        events += [dict(e, at=round(i / fps, 2)) for e in found]
    return events


def kinds(events):
    return [(e['at'], e['type']) for e in events]


# ── settings and the builder ────────────────────────────────────────────────────────────────────────────────────────
def test_each_condition_has_its_own_defaults():
    assert settings_for(dict(condition='dwells')).dwell_seconds == 30 and settings_for(dict(condition='dwells')).min_motion_px == 0
    assert settings_for(dict(condition='enters')).min_motion_px == 10
    assert settings_for(dict(condition='stopped')).min_motion_px == 12 and settings_for(dict(condition='stopped')).dwell_seconds == 30
    assert settings_for(dict(condition='crowd', crowdOver=5)).dwell_seconds == 5
    assert settings_for(dict(condition='crosses')).min_frames == 2
    assert settings_for(dict(condition='dwells', durationSec=90, minMovePx=15)).dwell_seconds == 90


def test_settings_out_of_range_and_unknown_conditions_are_refused():
    for bad in (dict(condition='crowd'), dict(condition='crowd', crowdOver=0), dict(condition='no-ppe'),
                dict(condition='dwells', minConfidence=2), dict(condition='dwells', durationSec=-1)):
        with pytest.raises(ValueError):
            settings_for(bad)


def test_a_stopped_rule_is_always_about_vehicles():
    assert subject_of(dict(condition='stopped', subject='person')) == 'vehicle'
    assert subject_of(dict(condition='dwells', subject='any')) == 'any'
    assert subject_of(dict(condition='dwells')) == 'person'


def test_build_engine_picks_the_right_class_and_skips_a_rule_with_nothing_to_watch():
    zones = [AREA, LINE]
    assert isinstance(build_engine(dict(condition='enters', zoneIds=['a1']), zones, W, H), IntrusionRule)
    assert build_engine(dict(condition='enters', zoneIds=['a1']), zones, W, H).kind == 'enters'
    assert build_engine(dict(condition='dwells', zoneIds=['a1']), zones, W, H).kind == 'dwells'
    assert isinstance(build_engine(dict(condition='outside', zoneIds=['a1']), zones, W, H), OutsideRule)
    assert isinstance(build_engine(dict(condition='crosses', zoneIds=['l1']), zones, W, H), LineRule)
    assert isinstance(build_engine(dict(condition='crowd', crowdOver=3, zoneIds=['a1']), zones, W, H), CrowdRule)
    assert isinstance(build_engine(dict(condition='stopped'), zones, W, H), StoppedRule)         # no zone picked: the whole view
    assert build_engine(dict(condition='crosses', zoneIds=['a1']), zones, W, H) is None        # a polygon is not a line
    assert build_engine(dict(condition='crosses'), zones, W, H) is None                        # a line has to be drawn
    assert build_engine(dict(condition='outside'), zones, W, H) is None                        # the allowed areas must be named
    assert build_engine(dict(condition='dwells', zoneIds=['gone']), zones, W, H) is None


def test_the_region_to_watch_is_known_for_each_engine():
    zones = [AREA, LINE]
    assert build_engine(dict(condition='dwells', zoneIds=['a1']), zones, W, H).watch_points.shape[1] == 2
    assert build_engine(dict(condition='outside', zoneIds=['a1']), zones, W, H).watch_points is None
    assert build_engine(dict(condition='crosses', zoneIds=['l1']), zones, W, H).watch_points.tolist() == [[500.0, 0.0], [500.0, 1000.0]]


# ── dwelling ────────────────────────────────────────────────────────────────────────────────────────────────────────
def dwell_engine(seconds=5.0, **extra):
    return build_engine(dict(condition='dwells', zoneIds=['a1'], durationSec=seconds, **extra), [AREA], W, H)


def test_standing_still_in_the_zone_alerts_after_the_dwell_time():
    events = run(dwell_engine(5.0), [[box(600, 600)]] * 100)
    assert kinds(events) == [(5.0, 'alert')]
    assert events[0]['dwell'] == 5.0


def test_walking_through_does_not_dwell_and_leaving_resets_the_timer():
    events = run(dwell_engine(5.0), [[box(600, 600)]] * 40 + [[box(100, 100)]] * 30 + [[box(600, 600)]] * 40)
    assert events == []


def test_dwelling_ignores_people_outside_the_zone_and_needs_a_confident_detection():
    assert run(dwell_engine(1.0), [[box(100, 100)]] * 50) == []
    assert run(dwell_engine(1.0), [[box(600, 600, conf=0.3)]] * 50) == []          # the dwell default wants 0.4
    assert kinds(run(dwell_engine(1.0, minConfidence=0.2), [[box(600, 600, conf=0.3)]] * 50)) == [(1.0, 'alert')]


# ── outside ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def outside_engine(seconds=2.0, **extra):
    return build_engine(dict(condition='outside', zoneIds=['a1'], durationSec=seconds, minMovePx=0, **extra), [AREA], W, H)


def test_outside_the_allowed_area_for_long_enough_alerts_once():
    events = run(outside_engine(2.0), [[box(100, 100)]] * 60)
    assert kinds(events) == [(2.0, 'alert')]
    assert events[0]['zone_id'] == '__outside__' and events[0]['zone_name'] == 'outside the allowed areas'


def test_inside_the_allowed_area_never_alerts():
    assert run(outside_engine(1.0), [[box(600, 600)]] * 60) == []


def test_stepping_out_for_less_than_the_time_does_nothing():
    assert run(outside_engine(3.0), [[box(100, 100)]] * 15 + [[box(600, 600)]] * 40) == []


def test_outside_walks_the_same_checks_as_the_intrusion_rule():
    # the default movement check: a track that never moves is a pole, not a person
    still = build_engine(dict(condition='outside', zoneIds=['a1'], durationSec=1.0), [AREA], W, H)
    assert run(still, [[box(100, 100)]] * 60) == []
    walking = build_engine(dict(condition='outside', zoneIds=['a1'], durationSec=1.0), [AREA], W, H)
    frames = [[box(100 + 6 * i, 100)] for i in range(0, 60)]
    assert [e['type'] for e in run(walking, frames)] == ['alert']


# ── crossing a line ─────────────────────────────────────────────────────────────────────────────────────────────────
def line_engine(**extra):
    return build_engine(dict(condition='crosses', zoneIds=['l1'], **extra), [LINE], W, H)


def walk(xs, y=500, **kw):
    return [[box(x, y, **kw)] for x in xs]


def test_crossing_the_line_alerts_with_the_direction():
    events = run(line_engine(), walk(range(400, 620, 10)))
    assert [e['type'] for e in events] == ['alert'] and events[0]['direction'] == -1 and events[0]['zone_name'] == 'Gate line'
    back = run(line_engine(), walk(range(600, 380, -10)))
    assert back[0]['direction'] == 1                       # the same line crossed the other way


def test_walking_along_the_line_or_stopping_short_is_not_a_crossing():
    assert run(line_engine(), walk([450] * 40)) == []
    assert run(line_engine(), [[box(470, 100 + 10 * i)] for i in range(40)]) == []        # parallel to it
    assert run(line_engine(), walk(range(400, 480, 10))) == []


def test_jitter_on_the_line_is_not_a_crossing_but_a_real_one_after_it_still_is():
    wobble = [490, 505, 495, 508, 492, 503, 497, 506] * 4
    assert run(line_engine(), walk([440] * 5 + wobble)) == []
    events = run(line_engine(), walk([440] * 5 + wobble + [560] * 5))
    assert [e['type'] for e in events] == ['alert']


def test_the_end_of_a_short_line_can_be_walked_around():
    short = dict(id='s', name='Short', kind='line', points=[[50, 40], [50, 60]])         # x=500, y 400..600
    engine = build_engine(dict(condition='crosses', zoneIds=['s']), [short], W, H)
    frames = [[box(450, 300 + 10 * i)] for i in range(5)] + [[box(550, 360)]] * 4 + [[box(550, 340)]] * 4        # around the top
    assert run(engine, frames) == []


def test_crossing_back_within_the_repeat_time_is_held_back():
    events = run(line_engine(repeatSec=60), walk(list(range(400, 620, 10)) + list(range(600, 380, -10))))
    assert [e['type'] for e in events] == ['alert', 'suppressed']
    events = run(line_engine(repeatSec=1), walk(list(range(400, 620, 10)) + [620] * 20 + list(range(600, 380, -10))))
    assert [e['type'] for e in events] == ['alert', 'alert'] and events[1]['reentry'] is True


def test_a_polyline_is_crossed_on_any_of_its_segments():
    engine = build_engine(dict(condition='crosses', zoneIds=['l2']), [BENT], W, H)
    assert [e['type'] for e in run(engine, [[box(700, 600 + 10 * i - 30)] for i in range(0, 6)])] == []           # next to the bend
    engine = build_engine(dict(condition='crosses', zoneIds=['l2']), [BENT], W, H)
    down_the_bend = [[box(300, 400 + 10 * i)] for i in range(0, 20)]                                              # crosses the flat part
    assert [e['type'] for e in run(engine, down_the_bend)] == ['alert']
    engine = build_engine(dict(condition='crosses', zoneIds=['l2']), [BENT], W, H)
    assert [e['type'] for e in run(engine, walk(range(400, 620, 10), y=700))] == ['alert']                        # crosses the upright part


def test_a_track_needs_the_minimum_frames_and_confidence_to_count():
    assert run(line_engine(minFrames=40), walk(range(400, 620, 10))) == []
    assert run(line_engine(minConfidence=0.95), walk(range(400, 620, 10))) == []


def test_two_people_cross_independently_and_the_preview_marks_a_crosser_briefly():
    engine = line_engine()
    a, b = walk(range(400, 620, 10), track=1), walk(range(600, 380, -10), track=2)
    both = [x + y for x, y in zip(a, b)]
    events = run(engine, both)
    assert sorted(e['id'] for e in events if e['type'] == 'alert') == [1, 2]
    info, _ = engine.update(2.2, [box(900, 300, track=1)])
    assert info[1]['flagged'] is True
    info, _ = engine.update(9.0, [box(900, 300, track=1)])
    assert info[1]['flagged'] is False


def test_geometry_helpers():
    assert segments_cross((0, 0), (10, 10), (0, 10), (10, 0)) and not segments_cross((0, 0), (4, 4), (0, 10), (10, 0))
    assert distance_to_segment((5, 5), (0, 0), (10, 0)) == 5 and distance_to_segment((15, 0), (0, 0), (10, 0)) == 5
    lines = lines_to_pixels([LINE, AREA, dict(id='x', kind='line', points=[[1, 1]])], W, H)
    assert [l.id for l in lines] == ['l1'] and lines[0].points.tolist() == [[500.0, 0.0], [500.0, 1000.0]]


# ── a crowd ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def crowd_engine(limit=3, seconds=2.0, **extra):
    return build_engine(dict(condition='crowd', zoneIds=['a1'], crowdOver=limit, durationSec=seconds, **dict(dict(minFrames=1), **extra)), [AREA], W, H)


def people(n, offset=0):
    return [box(450 + 40 * i, 600, track=offset + i + 1) for i in range(n)]


def test_more_than_the_limit_for_long_enough_alerts_with_the_count():
    events = run(crowd_engine(3, 2.0), [people(5)] * 60)
    assert kinds(events)[0] == (2.0, 'alert') and events[0]['count'] == 5 and events[0]['limit'] == 3
    assert events[0]['box_px'] == [400.0, 400.0, 900.0, 900.0]


def test_exactly_the_limit_is_not_a_crowd():
    assert run(crowd_engine(3, 1.0), [people(3)] * 60) == []


def test_a_short_surge_does_not_alert_and_a_one_frame_dip_does_not_reset_the_wait():
    assert run(crowd_engine(3, 3.0), [people(5)] * 10 + [people(1)] * 40) == []
    dip = [people(5)] * 10 + [people(2)] + [people(5)] * 20
    assert kinds(run(crowd_engine(3, 2.0), dip))[0] == (2.0, 'alert')


def test_it_alerts_again_while_the_crowd_lasts_and_clears_when_it_goes():
    events = run(crowd_engine(3, 1.0, repeatSec=10), [people(5)] * 300 + [people(0)] * 30)
    alerts = [e for e in events if e['type'] == 'alert']
    assert len(alerts) == 3 and alerts[1]['reentry'] is True and [e['at'] for e in alerts] == [1.0, 11.0, 21.0]
    assert events[-1]['type'] == 'cleared'


def test_a_crowd_that_comes_back_inside_the_repeat_time_is_held_back():
    frames = [people(5)] * 20 + [people(0)] * 30 + [people(5)] * 30
    assert [e['type'] for e in run(crowd_engine(3, 1.0, repeatSec=120), frames)] == ['alert', 'cleared']


def test_people_outside_the_zone_and_unsure_detections_are_not_counted():
    outside = [box(100 + 40 * i, 100, track=i + 1) for i in range(8)]
    assert run(crowd_engine(3, 1.0), [outside] * 40) == []
    unsure = [box(450 + 40 * i, 600, conf=0.1, track=i + 1) for i in range(8)]
    assert run(crowd_engine(3, 1.0), [unsure] * 40) == []


def test_a_person_has_to_be_seen_for_the_minimum_frames_before_they_are_counted():
    # counted from the 5th frame (0.4 s); the count is a median over 4 s, so it is over the limit once more than half the
    # frames seen so far had the crowd: at 0.8 s
    assert kinds(run(crowd_engine(3, 0.0, minFrames=5), [people(5)] * 20))[0] == (0.8, 'alert')


def test_each_zone_is_counted_on_its_own_and_the_crowd_is_marked_in_the_preview():
    other = dict(id='a2', name='Yard', kind='polygon', points=[[0, 0], [30, 0], [30, 30], [0, 30]])
    engine = build_engine(dict(condition='crowd', zoneIds=['a1', 'a2'], crowdOver=3, durationSec=1.0), [AREA, other], W, H)
    frames = [people(4) + [box(50, 100, track=20), box(100, 100, track=21)]] * 30
    info = None
    events = []
    for i, tracks in enumerate(frames):
        info, found = engine.update(i / FPS, tracks)
        events += found
    assert [e['zone_id'] for e in events if e['type'] == 'alert'] == ['a1']
    assert info[1]['flagged'] is True and info[20]['flagged'] is False


# ── a stopped vehicle ───────────────────────────────────────────────────────────────────────────────────────────────
def car(x, y, track=3, conf=0.8, w=120, h=60):
    return (track, x - w / 2, y - h, x + w / 2, y, conf)


def stopped_engine(seconds=5.0, **extra):
    return build_engine(dict(condition='stopped', zoneIds=['a1'], durationSec=seconds, **extra), [AREA], W, H)


def arrive(x0=400, steps=8, y=600):
    """A car driving in from the left, 15 px a frame: the last frame has it at x0 + 15 * (steps - 1)."""
    return [[car(x0 + 15 * i, y)] for i in range(steps)]


def still(x, n, y=600):
    return [[car(x, y)]] * n


STOP_X = 400 + 15 * 7        # where an arriving car stops
STOP_AT = 0.7                # the last frame it moved; the stillness is counted from then


def test_a_vehicle_that_drives_in_and_stops_alerts_after_the_time():
    events = run(stopped_engine(5.0), arrive() + still(STOP_X, 100))
    assert kinds(events) == [(round(STOP_AT + 5.0, 2), 'alert')] and events[0]['dwell'] == 5.0


def test_a_vehicle_that_was_never_seen_moving_is_not_reported():
    # parked before the camera looked, or a building the detector calls a truck
    assert run(stopped_engine(5.0), still(600, 200)) == []


def test_a_moving_vehicle_never_alerts_and_noise_in_the_box_does_not_count_as_moving():
    assert run(stopped_engine(5.0), [[car(420 + 4 * i, 600)] for i in range(100)]) == []
    jitter = [[car(STOP_X + (2 if i % 2 else -2), 600 + (1 if i % 3 else -1))] for i in range(100)]
    assert [e['type'] for e in run(stopped_engine(5.0), arrive() + jitter)] == ['alert']


def test_moving_off_clears_it_and_stopping_again_alerts_after_the_repeat_time():
    frames = arrive() + still(STOP_X, 70) + [[car(STOP_X + 20 * i, 600)] for i in range(1, 6)] + still(STOP_X + 100, 70)
    events = run(stopped_engine(5.0, repeatSec=3), frames)
    assert [e['type'] for e in events] == ['alert', 'left', 'alert'] and events[2]['reentry'] is True
    held = run(stopped_engine(5.0, repeatSec=600), frames)
    assert [e['type'] for e in held] == ['alert', 'left', 'suppressed']


def test_a_vehicle_that_stays_keeps_being_reported_every_repeat_time():
    events = run(stopped_engine(2.0, repeatSec=5), arrive() + still(STOP_X, 200))
    times = [e['at'] for e in events if e['type'] == 'alert']
    assert len(times) == 4 and times[0] == 2.7 and all(5.0 <= b - a <= 5.2 for a, b in zip(times, times[1:]))       # every repeat time
    assert [e['type'] for e in run(stopped_engine(2.0, repeatSec=0), arrive() + still(STOP_X, 200))] == ['alert']      # 0: no repeats


def test_a_vehicle_outside_the_zone_is_ignored():
    assert run(stopped_engine(1.0), arrive(x0=100, y=100) + still(205, 100, y=100)) == []


def test_the_whole_view_is_watched_when_no_zone_is_picked():
    engine = build_engine(dict(condition='stopped', durationSec=1.0), [AREA], W, H)
    assert [e['type'] for e in run(engine, arrive(x0=100, y=100) + still(205, 30, y=100))] == ['alert']


# ── the vehicle tracker ─────────────────────────────────────────────────────────────────────────────────────────────
def test_the_tracker_keeps_an_id_for_a_vehicle_that_overlaps_itself_and_gives_others_their_own():
    tracker = VehicleTracker(min_hits=2)
    ids = []
    for i in range(10):
        out = tracker.update(i / FPS, [(100 + 3 * i, 100, 220 + 3 * i, 160, 0.8), (600, 500, 720, 560, 0.7)])
        ids.append(sorted(t[0] for t in out))
    assert ids[0] == [] and ids[1] == [1, 2] and ids[-1] == [1, 2]


def test_a_one_frame_ghost_never_gets_an_id_and_a_vehicle_missed_briefly_keeps_its_id():
    tracker = VehicleTracker(min_hits=2, max_age=2.0)
    assert tracker.update(0.0, [(0, 0, 50, 50, 0.9)]) == []
    assert tracker.update(0.1, []) == []
    tracker = VehicleTracker(min_hits=2, max_age=2.0)
    tracker.update(0.0, [(100, 100, 220, 160, 0.8)])
    first = tracker.update(0.1, [(100, 100, 220, 160, 0.8)])[0][0]
    tracker.update(0.5, [])
    assert tracker.update(1.0, [(102, 100, 222, 160, 0.8)])[0][0] == first
    tracker.update(5.0, [])
    assert tracker.update(5.1, [(102, 100, 222, 160, 0.8)]) == []                 # forgotten after max_age: a new, unconfirmed track


def test_overlapping_vehicles_are_matched_one_to_one():
    tracker = VehicleTracker(min_hits=1)
    out = tracker.update(0.0, [(100, 100, 220, 160, 0.9), (130, 100, 250, 160, 0.8)])
    again = tracker.update(0.1, [(102, 100, 222, 160, 0.9), (132, 100, 252, 160, 0.8)])
    assert sorted(t[0] for t in out) == sorted(t[0] for t in again) and len({t[0] for t in again}) == 2
