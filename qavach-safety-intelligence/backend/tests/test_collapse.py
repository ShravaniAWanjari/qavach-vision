import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from qavach.collapse import Collapse, body  # noqa: E402

FPS = 10


def pose(lean_deg=0.0, hip_y=500.0, torso=150.0, x=300.0, legs=None):
    """A person whose trunk leans `lean_deg` from vertical: shoulders above the hips (hip_y is image y, down is larger)."""
    k = np.zeros((17, 3))
    dx = torso * np.sin(np.radians(lean_deg))
    dy = torso * np.cos(np.radians(lean_deg))
    k[5] = (x - 30 + dx, hip_y - dy, 0.9)
    k[6] = (x + 30 + dx, hip_y - dy, 0.9)
    k[11] = (x - 25, hip_y, 0.9)
    k[12] = (x + 25, hip_y, 0.9)
    k[0] = (x + dx * 1.2, hip_y - dy * 1.25, 0.9)
    leg = torso * 1.6 if legs is None else legs          # the legs hang down when standing, lie flat when down
    k[15] = (x - 25, hip_y + leg, 0.9)
    k[16] = (x + 25, hip_y + leg, 0.9)
    return k


def run(frames, c=None):
    c = c or Collapse()
    events = []
    for i, k in enumerate(frames):
        events += [dict(e, at=i / FPS) for e in c.update(i / FPS, k)[1]]
    return c, events


def stand(seconds):
    return [pose() for _ in range(int(seconds * FPS))]


def lie(seconds):
    return [pose(lean_deg=85, hip_y=620, torso=150, legs=5) for _ in range(int(seconds * FPS))]


def test_trunk_angle_and_unreadable_poses():
    lean, hip_y, torso, height = body(pose(lean_deg=0))
    assert lean < 1 and abs(torso - 150) < 1
    assert body(pose(lean_deg=90))[0] > 89
    k = pose()
    k[[5, 6], 2] = 0.0
    assert body(k) is None


def test_standing_still_never_alerts():
    _, events = run(stand(20))
    assert events == []


def test_falling_and_staying_down_raises_down_then_collapsed():
    c, events = run(stand(8) + [pose(45, 560, 150, 60)] * 3 + lie(8))
    kinds = [e['type'] for e in events]
    assert kinds == ['down', 'collapsed'], kinds
    assert c.state == 'collapsed'


def test_getting_back_up_cancels_the_alert_and_a_second_fall_alerts_again():
    c, events = run(stand(8) + lie(2) + stand(6) + lie(6))
    kinds = [e['type'] for e in events]
    assert kinds == ['down', 'down', 'collapsed'], kinds           # first fall: got up in time; second: stayed down


def test_bending_over_with_the_hips_still_high_is_not_a_fall():
    bend = [pose(lean_deg=70, hip_y=500, torso=150) for _ in range(60)]
    _, events = run(stand(8) + bend + stand(3))
    assert events == []


def test_a_one_frame_stumble_is_filtered():
    _, events = run(stand(8) + lie(0.3) + stand(8))
    assert events == []


def test_frames_with_nobody_readable_change_nothing():
    c, events = run(stand(8) + lie(2) + [None] * 30 + lie(5))
    assert [e['type'] for e in events] == ['down', 'collapsed']


def test_a_crouch_or_squat_is_not_a_fall():
    """Hips well down and the body shorter, but upright: crouching to pick something up."""
    crouch = [pose(lean_deg=15, hip_y=560, torso=150, legs=70) for _ in range(40)]
    _, events = run(stand(8) + crouch + stand(3))
    assert events == []


def test_a_modest_lean_still_counts_when_the_body_is_flat_and_dropped():
    """A lying person the pose model reads at 45 degrees, with the hips far down and the body flat."""
    flat = [pose(lean_deg=45, hip_y=640, torso=150, legs=5) for _ in range(30)]
    _, events = run(stand(8) + flat)
    assert [e['type'] for e in events][:1] == ['down']


# ── the engine around it ─────────────────────────────────────────────────────────────────────────────────────────────
def _rule_run(frames, seconds_down=3.0):
    from qavach.fallrule import CollapseRule
    from qavach.intrusion import Rule, ZonePx
    zone = ZonePx(id='z', name='Yard', points=np.array([[0, 0], [1280, 0], [1280, 720], [0, 720]], dtype=np.int32),
                  points_pct=[[0, 0], [100, 0], [100, 100], [0, 100]])
    engine = CollapseRule([zone], Rule(dwell_seconds=seconds_down, min_frames=1, min_confidence=0.0, repeat_seconds=0.0))
    alerts = []
    for i, k in enumerate(frames):
        engine.pose = {7: k}
        _, events = engine.update(i / FPS, [(7, 280, 350, 320, 500, 0.9)])
        alerts += [e for e in events if e['type'] == 'alert']
    return alerts


def test_rule_alerts_when_someone_falls_and_stays_down():
    alerts = _rule_run(stand(8) + lie(8))
    assert len(alerts) == 1 and alerts[0]['id'] == 7


def test_rule_does_not_alert_when_they_get_up():
    assert _rule_run(stand(8) + lie(1.5) + stand(5)) == []
