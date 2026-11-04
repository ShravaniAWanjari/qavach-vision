import numpy as np
import pytest

from qavach.fire import FireEngine, FireRule
from qavach.intrusion import ZonePx


def area(name, x1, y1, x2, y2):
    pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    return ZonePx(id=name, name=name, points=np.array(pts, dtype=np.int32), points_pct=[[float(a), float(b)] for a, b in pts])


FIRE = ('fire', 0.6, (100, 100, 140, 140))
SMOKE = ('smoke', 0.5, (300, 100, 380, 180))


def run(engine, frames, fps=10.0):
    events = []
    for i, detections in enumerate(frames):
        events += engine.update(i / fps, detections)[1]
    return events


def alerts(events):
    return [e for e in events if e['type'] == 'alert']


def test_a_single_glint_does_not_alert():
    engine = FireEngine(FireRule(), [], [])
    assert not alerts(run(engine, [[FIRE]] + [[]] * 10))


def test_a_class_seen_in_enough_frames_alerts_once():
    engine = FireEngine(FireRule(min_hits=4), [], [])
    events = alerts(run(engine, [[FIRE]] * 8))
    assert len(events) == 1 and events[0]['hazard'] == 'fire' and events[0]['frames'] == 4
    assert events[0]['box'] == [100.0, 100.0, 140.0, 140.0]


def test_the_hits_need_not_be_in_a_row():
    engine = FireEngine(FireRule(min_hits=4), [], [])
    frames = [[FIRE], [], [FIRE], [], [FIRE], [], [FIRE]]
    assert len(alerts(run(engine, frames))) == 1


def test_fire_and_smoke_alert_separately():
    engine = FireEngine(FireRule(), [], [])
    events = alerts(run(engine, [[FIRE, SMOKE]] * 6))
    assert sorted(e['hazard'] for e in events) == ['fire', 'smoke']


def test_a_rule_for_smoke_only_ignores_fire():
    engine = FireEngine(FireRule(classes='smoke'), [], [])
    assert not alerts(run(engine, [[FIRE]] * 8))
    assert len(alerts(run(engine, [[SMOKE]] * 8))) == 1


def test_detections_below_the_confidence_setting_do_not_count():
    engine = FireEngine(FireRule(min_confidence=0.7), [], [])
    assert not alerts(run(engine, [[FIRE]] * 8))          # 0.6 < 0.7


def test_with_watch_areas_only_detections_inside_one_count():
    engine = FireEngine(FireRule(), [area('Workshop', 0, 0, 200, 200)], [])
    assert len(alerts(run(engine, [[FIRE]] * 6))) == 1
    outside = FireEngine(FireRule(), [area('Workshop', 0, 0, 90, 90)], [])
    assert not alerts(run(outside, [[FIRE]] * 6))


def test_the_alert_names_the_watch_area_it_is_in():
    engine = FireEngine(FireRule(), [area('Hot work bay', 0, 0, 200, 200)], [])
    event = alerts(run(engine, [[FIRE]] * 6))[0]
    assert event['zone_name'] == 'Hot work bay' and event['zone_id'] == 'Hot work bay'


def test_an_ignore_area_stops_detections_in_it_even_with_no_watch_areas():
    engine = FireEngine(FireRule(), [], [area('Exhaust stack', 90, 90, 150, 150)])
    assert not alerts(run(engine, [[FIRE]] * 8))
    assert len(alerts(run(engine, [[SMOKE]] * 8))) == 1


def test_an_ignore_area_wins_over_a_watch_area():
    engine = FireEngine(FireRule(), [area('Yard', 0, 0, 500, 500)], [area('Flare', 90, 90, 150, 150)])
    assert not alerts(run(engine, [[FIRE]] * 8))


def test_repeat_suppression_holds_back_a_second_alert_and_it_clears_between():
    engine = FireEngine(FireRule(repeat_seconds=120, clear_seconds=1.0), [], [])
    events = run(engine, [[FIRE]] * 6 + [[]] * 30 + [[FIRE]] * 6)
    assert len(alerts(events)) == 1
    assert [e['type'] for e in events if e['type'] != 'alert'] == ['cleared', 'suppressed']


def test_without_suppression_it_alerts_again_after_it_clears():
    engine = FireEngine(FireRule(repeat_seconds=0, clear_seconds=1.0), [], [])
    events = alerts(run(engine, [[FIRE]] * 6 + [[]] * 30 + [[FIRE]] * 6))
    assert len(events) == 2 and events[1]['repeat'] is True


def test_active_now_follows_the_alert():
    engine = FireEngine(FireRule(), [], [])
    run(engine, [[FIRE]] * 6)
    assert engine.active_now == ['fire']


@pytest.mark.parametrize('values', [dict(classes='gas'), dict(min_confidence=1.5), dict(min_hits=0), dict(min_hits=9),
                                    dict(repeat_seconds=-1)])
def test_out_of_range_settings_are_refused(values):
    with pytest.raises(ValueError):
        FireRule.from_dict(values)
