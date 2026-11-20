"""People counting for crowd rules: the tile merge (crowdcount.py) and the crowd rule counting the runner's person boxes, with a
median over a few seconds. Made-up boxes only (no model)."""
from qavach import crowdcount
from qavach.zonerules import build_engine

W, H = 1000, 1000
FPS = 10.0
AREA = dict(id='a1', name='Restricted area', kind='polygon', points=[[40, 40], [90, 40], [90, 90], [40, 90]])   # pixels 400..900


def boxes(n, conf=0.8):
    """n people with their feet inside AREA."""
    return [(410 + 30 * (i % 15), 500, 425 + 30 * (i % 15), 600 + 10 * (i // 15), conf) for i in range(n)]


def crowd(limit=10, seconds=2.0):
    return build_engine(dict(condition='crowd', zoneIds=['a1'], crowdOver=limit, durationSec=seconds, minFrames=1), [AREA], W, H)


def drive(engine, counts, fps=FPS):
    events = []
    for i, n in enumerate(counts):
        engine.people = boxes(n)
        events += [dict(e, at=round(i / fps, 2)) for e in engine.update(i / fps, [])[1]]
    return events


def test_tiles_cover_the_region_with_overlap():
    t = crowdcount.tiles((0, 0, 1000, 800), grid=2, overlap=0.25)
    assert len(t) == 4 and t[0][0] == 0 and t[-1][2] == 1000 and t[-1][3] == 800
    assert t[1][0] < t[0][2]                                   # neighbours overlap


def test_merge_adds_only_new_small_people_and_drops_cut_boxes():
    region = (0, 0, 1000, 1000)
    whole = [(100, 100, 300, 600, 0.9)]                       # a big person near the camera, found by the region pass
    tile = (0, 0, 571, 571)
    found = [((100, 100, 300, 568, 0.7), tile),               # the same person, cut by the tile's bottom edge
             ((400, 200, 420, 250, 0.6), tile),               # a small person only the tile finds
             ((401, 201, 421, 251, 0.5), (429, 0, 1000, 571))]   # the same small person seen again by the next tile
    merged = crowdcount.merge(whole, found, region)
    assert len(merged) == 2 and merged[1][:4] == (400, 200, 420, 250)


def test_people_boxes_are_counted_not_tracks():
    events = drive(crowd(limit=10, seconds=1.0), [14] * 30)
    alerts = [e for e in events if e['type'] == 'alert']
    assert alerts and alerts[0]['count'] == 14 and alerts[0]['limit'] == 10


def test_a_count_that_flickers_over_the_limit_does_not_alert():
    flicker = [12 if i % 3 == 0 else 7 for i in range(60)]   # over the limit one frame in three: misses and double counts
    assert [e for e in drive(crowd(limit=10, seconds=1.0), flicker) if e['type'] == 'alert'] == []


def test_a_crowd_with_missed_people_on_some_frames_still_alerts_and_clears():
    dips = [14 if i % 4 else 8 for i in range(60)] + [0] * 60  # people hidden behind others on one frame in four
    events = drive(crowd(limit=10, seconds=2.0), dips)
    types = [e['type'] for e in events]
    assert types[0] == 'alert' and types[-1] == 'cleared'
    assert all(e['at'] < 6.0 for e in events if e['type'] == 'alert')     # never alerts after the crowd has gone


def test_slow_camera_keeps_the_crowd_between_frames():
    engine = crowd(limit=10, seconds=4.0)
    events = []
    for i in range(10):                                        # one analysed frame every 2 s
        engine.people = boxes(14)
        events += engine.update(i * 2.0, [])[1]
    assert [e['type'] for e in events].count('alert') == 1


def test_a_crowd_only_camera_runs_without_the_tracker():
    from qavach.camera_runner import needs_tracker
    intrusion = build_engine(dict(condition='enters', zoneIds=['a1'], durationSec=1.0), [AREA], W, H)
    vehicles = build_engine(dict(condition='crowd', subject='vehicle', zoneIds=['a1'], crowdOver=3, durationSec=1.0), [AREA], W, H)
    assert needs_tracker([(crowd(), {})]) is False
    assert needs_tracker([(crowd(), {}), (vehicles, {})]) is False
    assert needs_tracker([(crowd(), {}), (intrusion, {})]) is True


def test_people_outside_the_restricted_area_are_not_counted():
    engine = crowd(limit=10, seconds=1.0)
    inside = boxes(6)                                                        # feet inside the zone (400..900)
    outside = [(50 + 30 * i, 100, 70 + 30 * i, 300, 0.9) for i in range(20)]  # 20 people up and left of it
    edge = [(600, 850, 640, 950, 0.9)]                                        # body in the zone, feet below it
    events = []
    for i in range(30):
        engine.people = inside + outside + edge
        events += engine.update(i / FPS, [])[1]
    assert events == [] and engine.state['a1'].now == 6


def test_the_alert_reports_a_count_over_the_limit_never_the_smoothed_one():
    """The smoothed count lags: an alert raised while it is still under the limit must still say a count over the limit."""
    engine = crowd(limit=10, seconds=1.0)
    events = []
    for i, n in enumerate([14] * 20 + [11] + [9, 9, 12, 9]):
        engine.people = boxes(n)
        events += engine.update(i / FPS, [])[1]
    alerts = [e for e in events if e['type'] == 'alert']
    assert alerts and all(e['count'] > e['limit'] for e in alerts)
