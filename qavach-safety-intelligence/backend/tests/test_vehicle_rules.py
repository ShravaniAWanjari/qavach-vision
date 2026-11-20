import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qavach.zonerules import VEHICLE_ID_OFFSET, build_engine
from test_zone_rules import AREA, H, W, box, kinds, run

CAR = VEHICLE_ID_OFFSET + 1


def car(x, y, track=CAR):
    return box(x, y, h=80, w=160, track=track)


def dwell(seconds=5.0, **extra):
    return build_engine(dict(condition='dwells', subject='vehicle', zoneIds=['a1'], durationSec=seconds, minFrames=3, minConfidence=0.3, minMovePx=0, **extra), [AREA], W, H)


def speeding(limit=30, across=100, **extra):
    return build_engine(dict(condition='speeding', subject='vehicle', zoneIds=['a1'], durationSec=0.5, minFrames=3, minConfidence=0.3, speedKmh=limit, metersAcross=across, **extra), [AREA], W, H)


def test_a_vehicle_that_stays_in_the_zone_alerts_after_the_dwell_time_and_one_that_passes_through_does_not():
    events = run(dwell(5.0), [[car(600, 600)]] * 100)
    assert kinds(events)[0][1] == 'alert' and 5.0 <= events[0]['at'] < 6.0 and events[0]['dwell'] >= 5.0
    passing = [[car(300 + 12 * i, 600)] for i in range(60)]            # leaves the zone before 5 seconds are up
    assert run(dwell(5.0), passing) == []


def test_a_vehicle_outside_the_zone_never_dwells():
    assert run(dwell(2.0), [[car(150, 150)]] * 100) == []


def test_each_vehicle_is_timed_on_its_own():
    frames = [[car(500, 600, CAR), car(800, 700, CAR + 1)]] * 60
    alerts = [e for e in run(dwell(3.0), frames) if e['type'] == 'alert']
    assert sorted(e['id'] for e in alerts) == [CAR, CAR + 1]


def test_a_vehicle_over_the_speed_limit_alerts_with_its_speed_and_a_slow_one_does_not():
    # 10 frames a second, 20 px a frame = 200 px/s; 100 m across 1000 px = 0.1 m/px: 20 m/s = 72 km/h
    fast = [[car(420 + 20 * i, 600)] for i in range(24)]
    events = [e for e in run(speeding(30, 100), fast) if e['type'] == 'alert']
    assert events and 60 < events[0]['speed'] < 85 and events[0]['limit'] == 30
    slow = [[car(420 + 2 * i, 600)] for i in range(24)]                 # 7 km/h
    assert run(speeding(30, 100), slow) == []


def test_the_speed_follows_the_scale_the_rule_is_given():
    fast = [[car(420 + 20 * i, 600)] for i in range(24)]
    assert run(speeding(30, 100), fast) and not run(speeding(30, 20), fast)       # 14 km/h on a 20 m wide picture
