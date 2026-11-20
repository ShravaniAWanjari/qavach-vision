import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qavach.camera_runner import needs_tracker
from qavach.zonerules import GatheringRule, biggest_group, build_engine, settings_for
from test_zone_rules import AREA, H, W, box, kinds, run


def engine(group=5, seconds=2.0, **extra):
    return build_engine(dict(condition='gathering', zoneIds=['a1'], minPeople=group, durationSec=seconds, **dict(dict(minFrames=1), **extra)), [AREA], W, H)


def packed(n, offset=0, x=450, y=600, step=25):
    """n people shoulder to shoulder (25 px apart, bodies 60 px tall: well inside one group)."""
    return [box(x + step * i, y, track=offset + i + 1) for i in range(n)]


def spread(n, offset=100):
    """n people far apart from each other, all inside the zone."""
    return [box(430 + 150 * (i % 3), 450 + 150 * (i // 3), track=offset + i + 1) for i in range(n)]


def test_it_is_built_and_validated():
    assert isinstance(engine(), GatheringRule) and engine().kind == 'gathering'
    assert settings_for(dict(condition='gathering', minPeople=5)).dwell_seconds == 10
    for bad in (dict(condition='gathering'), dict(condition='gathering', minPeople=2)):
        with pytest.raises(ValueError):
            settings_for(bad)


def test_a_group_packed_together_alerts_with_its_size_and_is_boxed_on_the_group():
    events = run(engine(5, 2.0), [packed(6)] * 60)
    assert kinds(events)[0] == (2.0, 'alert')
    assert events[0]['count'] == 6 and events[0]['limit'] == 5
    x1, y1, x2, y2 = events[0]['box_px']
    assert x1 < 450 and x2 > 450 + 25 * 5 and (x2 - x1) < 400            # round the people, not the whole zone


def test_the_same_number_of_people_spread_out_is_not_a_gathering():
    assert run(engine(5, 1.0), [spread(9)] * 60) == []


def test_two_small_groups_are_not_one_big_one():
    two = packed(3, x=430, y=500) + packed(3, offset=10, x=430, y=800)
    assert run(engine(5, 1.0), [two] * 60) == []


def test_a_group_has_to_stay_together_for_the_rule_time():
    assert run(engine(5, 3.0), [packed(6)] * 15 + [spread(6)] * 40) == []


def test_people_outside_the_zone_do_not_join_the_group():
    inside_and_out = packed(3, x=430, y=500) + [box(100, 500, track=50 + i) for i in range(4)]
    assert run(engine(5, 1.0), [inside_and_out] * 60) == []


def test_a_single_dropped_frame_does_not_end_the_wait():
    frames = [packed(6)] * 10 + [packed(2)] + [packed(6)] * 20
    assert kinds(run(engine(5, 2.0), frames))[0] == (2.0, 'alert')


def test_only_the_people_in_the_group_are_marked():
    eng = engine(4, 1.0)
    group = packed(5, x=430, y=500)
    stray = [box(800, 850, track=77)]
    info = {}
    for i in range(40):
        info, _ = eng.update(i / 10, group + stray)
    assert all(info[t]['flagged'] for t in range(1, 6)) and not info[77]['flagged']


def test_a_chain_of_close_people_is_one_group_and_the_helper_measures_it():
    feet = [(100 + 25 * i, 500.0, 60.0) for i in range(8)]
    size, bounds = biggest_group(feet)
    assert size == 8 and bounds[0] < 100 and bounds[2] > 100 + 25 * 7
    assert biggest_group([]) == (0, None)
    assert biggest_group([(0.0, 0.0, 60.0), (500.0, 0.0, 60.0)])[0] == 1


def test_a_gathering_needs_no_tracker_like_a_crowd():
    eng = engine()
    assert needs_tracker([(eng, {})]) is False


def test_a_looser_reach_makes_a_large_loose_crowd_one_group():
    loose = [box(450 + 55 * i, 600, track=i + 1) for i in range(8)]          # 55 px apart, bodies 60 px tall
    assert run(engine(6, 1.0), [loose] * 60) == []                           # not shoulder to shoulder
    events = run(build_engine(dict(condition='gathering', zoneIds=['a1'], minPeople=6, durationSec=1.0, minFrames=1, gatherReach=1.0), [AREA], W, H), [loose] * 60)
    assert events and events[0]['count'] == 8


def test_how_close_must_be_in_range():
    with pytest.raises(ValueError):
        settings_for(dict(condition='gathering', minPeople=5, gatherReach=5))
