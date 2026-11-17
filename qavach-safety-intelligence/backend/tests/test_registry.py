import pytest

from qavach import config, registry as reg
from qavach.sources import Source


class FakeRunner:
    """Stands in for CameraRunner so no stream or model is touched."""
    instances = []

    def __init__(self, camera, rules, get_detector, emit, get_fire_detector=None, get_pose_detector=None):
        self.camera, self.rules, self.emit = camera, rules, emit
        self.stats, self.state, self.error = dict(fps=0), 'running', None
        self.stopped = False
        FakeRunner.instances.append(self)

    def stop(self):
        self.stopped = True


@pytest.fixture
def registry(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA', tmp_path)
    monkeypatch.setattr(config, 'STATE_FILE', tmp_path / 'state.json')
    monkeypatch.setattr(config, 'UPLOADS', tmp_path)
    monkeypatch.setattr(reg, 'CameraRunner', FakeRunner)
    FakeRunner.instances = []
    return reg.Registry()


CAM = dict(id='CAM-1', name='Ferry', source=dict(kind='link', url='https://www.youtube.com/live/QO-hO_kwwmY'),
           zones=[dict(id='Z1', name='Grid', purpose='restricted', kind='polygon', points=[[10, 10], [50, 10], [50, 50]])])
RULE = dict(id='R-1', name='Intrusion', cameraIds=['CAM-1'], zoneIds=['Z1'], subject='person', condition='enters',
            durationSec=3, minFrames=3, minConfidence=0.25, repeatSec=120, minMovePx=15, schedule='always', mode='live', priority='P2')


def test_a_camera_with_a_supported_rule_runs_with_that_rule(registry):
    registry.put_camera(CAM)
    registry.put_rule(RULE)
    runner = registry.runner('CAM-1')
    assert [r['id'] for r in runner.rules] == ['R-1']


def test_conditions_without_a_detector_do_not_run(registry):
    registry.put_camera(CAM)
    registry.put_rule(dict(RULE, id='R-2', condition='no-ppe'))
    assert registry.runner('CAM-1').rules == []
    assert 'R-2' in registry.rules                         # still stored: the console keeps it, the service just does not run it


def test_every_people_and_vehicle_condition_runs_for_real(registry):
    registry.put_camera(CAM)
    for condition in ('enters', 'dwells', 'outside', 'crosses', 'stopped'):
        registry.put_rule(dict(RULE, id=f'R-{condition}', condition=condition))
    registry.put_rule(dict(RULE, id='R-crowd', condition='crowd', crowdOver=4))
    registry.put_rule(dict(RULE, id='R-van', subject='vehicle'))
    assert sorted(r['id'] for r in registry.runner('CAM-1').rules) == sorted(['R-enters', 'R-dwells', 'R-outside', 'R-crosses', 'R-stopped', 'R-crowd', 'R-van'])
    assert registry.rules['R-crowd']['crowdOver'] == 4


def test_a_crowd_rule_needs_a_limit_and_other_new_settings_are_range_checked(registry):
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-c', condition='crowd'))
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-c', condition='crowd', crowdOver=0))
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-d', condition='dwells', minConfidence=3))
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-s', condition='stopped', durationSec=-4))


def test_an_unchanged_camera_is_not_restarted_by_a_sync(registry):
    registry.put_camera(CAM)
    registry.put_rule(RULE)
    first = registry.runner('CAM-1')
    assert registry.sync([CAM], [RULE]) == []
    assert registry.runner('CAM-1') is first and not first.stopped


def test_a_sync_never_removes_what_another_console_added(registry):
    other = dict(CAM, id='PER-11', source=dict(kind='link', url='https://example.com/stream.m3u8'))
    registry.put_camera(other)
    registry.put_rule(dict(RULE, id='R-9', cameraIds=['PER-11']))
    assert registry.sync([CAM], [RULE]) == []
    assert set(registry.cameras) == {'PER-11', 'CAM-1'} and set(registry.rules) == {'R-9', 'R-1'}
    assert registry.runner('PER-11') is not None and not registry.runner('PER-11').stopped


def test_a_replacing_sync_makes_the_service_match_the_console(registry):
    other = dict(CAM, id='PER-11', source=dict(kind='link', url='https://example.com/stream.m3u8'))
    registry.put_camera(other)
    registry.put_rule(dict(RULE, id='R-9', cameraIds=['PER-11']))
    assert registry.sync([CAM], [RULE], replace=True) == []
    assert set(registry.cameras) == {'CAM-1'} and set(registry.rules) == {'R-1'}
    assert registry.runner('PER-11') is None


def test_changing_a_rule_restarts_the_camera_and_removing_it_stops_detection(registry):
    registry.put_camera(CAM)
    registry.put_rule(RULE)
    first = registry.runner('CAM-1')
    registry.put_rule(dict(RULE, durationSec=10))
    assert first.stopped and registry.runner('CAM-1').rules[0]['durationSec'] == 10
    registry.delete_rule('R-1')
    assert registry.runner('CAM-1').rules == []


def test_deleting_a_camera_stops_its_runner(registry):
    registry.put_camera(CAM)
    runner = registry.runner('CAM-1')
    registry.delete_camera('CAM-1')
    assert runner.stopped and registry.runner('CAM-1') is None


def test_bad_input_is_rejected_with_a_message(registry):
    with pytest.raises(reg.Invalid):
        registry.put_camera(dict(CAM, id='../x'))
    with pytest.raises(reg.Invalid):
        registry.put_camera(dict(CAM, source=dict(kind='link', url='/etc/passwd')))
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, minConfidence=1.7))
    with pytest.raises(reg.Invalid):
        registry.put_camera(dict(CAM, zones=[dict(id='Z', points='nope')]))


def test_the_password_the_page_does_not_keep_is_remembered_and_saved_for_the_demo(registry, tmp_path):
    cam = dict(CAM, source=dict(kind='link', url='rtsp://10.0.0.5/s1', user='svc', password='pw'))
    registry.put_camera(cam)
    registry.put_camera(dict(cam, source=dict(kind='link', url='rtsp://10.0.0.5/s1', user='svc')))
    assert registry.cameras['CAM-1']['source'].password == 'pw'
    assert '"password": "pw"' in (tmp_path / 'state.json').read_text()     # demo: plain text, so a restart keeps the camera
    again = reg.Registry()
    again.load()
    assert again.cameras['CAM-1']['source'].password == 'pw'


def test_state_survives_a_restart(registry, tmp_path, monkeypatch):
    registry.put_camera(CAM)
    registry.put_rule(RULE)
    again = reg.Registry()
    again.load()
    assert set(again.cameras) == {'CAM-1'} and set(again.rules) == {'R-1'}


def test_events_get_a_sequence_number_and_a_snapshot_address(registry):
    registry.emit(dict(id='EV-aaaaaaaa'))
    registry.emit(dict(id='EV-bbbbbbbb'))
    found, latest = registry.events_since(1)
    assert [e['id'] for e in found] == ['EV-bbbbbbbb'] and latest == 2
    assert found[0]['snapshot'] == '/api/snapshots/EV-bbbbbbbb.jpg'


def test_alert_events_serialise_to_json(tmp_path, monkeypatch):
    """Boxes come from numpy track rows; an np.float32 in an event once made /api/events fail with a 500."""
    import json

    import numpy as np

    monkeypatch.setattr(config, 'SNAPSHOTS', tmp_path)

    from qavach.camera_runner import CameraRunner

    events = []
    runner = CameraRunner.__new__(CameraRunner)
    runner.camera, runner.stats, runner.emit, runner.recent = dict(id='CAM-1', source=Source('stream', url='x')), dict(alerts=0), events.append, []
    track = np.array([[100, 200, 140, 300, 7, 0.9, 0, 0]], dtype='<f4')[0]
    rows = [(int(track[4]), float(track[0]), float(track[1]), float(track[2]), float(track[3]), float(track[5]))]
    engine = type('E', (), dict(kind='enters', subject='person'))()
    runner._alert(np.zeros((720, 1280, 3), dtype=np.uint8), rows, dict(id='R-1', mode='live'), engine,
                  dict(id=7, zone_id='Z1', zone_name='Grid', confidence=0.9, dwell=1.2, frames=5, reentry=False, moved=22.5), 1280, 720)
    json.dumps(events[0])
    assert events[0]['condition'] == 'enters' and events[0]['subject'] == 'person' and events[0]['trackId'] == 7


def test_new_alert_events_serialise_and_carry_what_the_console_needs(tmp_path, monkeypatch):
    import json

    import numpy as np

    from qavach.camera_runner import CameraRunner
    from qavach.zonerules import OUTSIDE_ID, VEHICLE_ID_OFFSET

    monkeypatch.setattr(config, 'SNAPSHOTS', tmp_path)
    events = []
    runner = CameraRunner.__new__(CameraRunner)
    runner.camera, runner.stats, runner.emit, runner.recent = dict(id='CAM-1', source=Source('stream', url='x')), dict(alerts=0), events.append, []
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    car = VEHICLE_ID_OFFSET + 4
    runner._alert(frame, [(car, 100.0, 200.0, 300.0, 300.0, 0.8)], dict(id='R-S', mode='live'), type('E', (), dict(kind='stopped', subject='vehicle'))(),
                  dict(id=car, zone_id='Z1', zone_name='Lane', confidence=0.8, dwell=31.0, frames=40, reentry=False, moved=0.0), 1280, 720)
    runner._alert(frame, [], dict(id='R-C', mode='live'), type('E', (), dict(kind='crowd', subject='person'))(),
                  dict(id=0, zone_id='Z2', zone_name='Quay', confidence=0.7, dwell=6.0, frames=9, reentry=True, moved=0.0, count=9, limit=5,
                       box_px=[128.0, 72.0, 256.0, 144.0]), 1280, 720)
    runner._alert(frame, [(3, 10.0, 10.0, 50.0, 90.0, 0.9)], dict(id='R-O', mode='live'), type('E', (), dict(kind='outside', subject='person'))(),
                  dict(id=3, zone_id=OUTSIDE_ID, zone_name='outside the allowed areas', confidence=0.9, dwell=3.0, frames=8, reentry=False, moved=40.0), 1280, 720)
    runner._alert(frame, [(3, 10.0, 10.0, 50.0, 90.0, 0.9)], dict(id='R-L', mode='live'), type('E', (), dict(kind='crosses', subject='person'))(),
                  dict(id=3, zone_id='L1', zone_name='Gate line', confidence=0.9, dwell=0.0, frames=8, reentry=False, moved=0.0, direction=-1), 1280, 720)
    json.dumps(events)
    stopped, crowd, outside, crossed = events
    assert (stopped['condition'], stopped['subject'], stopped['trackId']) == ('stopped', 'vehicle', 4)
    assert (crowd['condition'], crowd['count'], crowd['limit'], crowd['trackId']) == ('crowd', 9, 5, 0) and crowd['box'] == [10.0, 10.0, 10.0, 10.0]
    assert outside['zoneId'] is None and outside['zoneName'] == 'outside the allowed areas'
    assert crossed['direction'] == -1 and crossed['zoneId'] == 'L1'


def test_the_live_reader_releases_its_own_capture_only_after_its_last_read():
    """Releasing a capture while another thread is inside read() crashed the whole service (SIGBUS in FFmpeg)."""
    import threading
    import time

    import numpy as np

    from qavach.camera_runner import LiveReader

    log = []
    in_read = threading.Event()

    class Capture:
        def read(self):
            log.append('read-start')
            in_read.set()
            time.sleep(0.2)
            log.append('read-end')
            return True, np.zeros((2, 2, 3), dtype=np.uint8)

        def release(self):
            log.append('release')

    reader = LiveReader(Capture(), 25.0)
    reader.start()
    in_read.wait(1)
    reader.stop_flag.set()
    reader.join(2)
    assert log[-1] == 'release' and log.index('release') > log.index('read-end')


def test_a_burst_of_frames_is_sampled_evenly_in_stream_time_not_collapsed_to_the_last_one():
    """A live stream delivering 150 frames at once, then nothing, used to yield one processed frame per burst."""
    import numpy as np

    from qavach.camera_runner import LiveReader

    class Never:
        def read(self):
            raise AssertionError('not started')

        def release(self):
            pass

    reader = LiveReader(Never(), 30.0)
    frame = np.zeros((4, 4, 3), dtype=np.uint8)
    import cv2
    data = cv2.imencode('.jpg', frame)[1].tobytes()
    for i in range(150):
        reader.buffer.append((i, data))
    reader.count = 150
    taken, wanted = [], 0
    while (got := reader.take(wanted)) is not None:
        taken.append(got[0])
        wanted = got[0] + 3                         # the detector needs about 100 ms per frame: skip 3 at 30 fps
    assert taken[:4] == [0, 3, 6, 9] and len(taken) == 50
    assert LiveReader(Never(), 30.0).take(0) is None
    reader.buffer.clear()
    reader.buffer.append((140, data))
    assert reader.take(10)[0] == 140                # a wanted frame that fell out of the buffer gives the oldest left


def test_the_movement_setting_travels_from_the_page_to_the_rule(registry):
    from qavach.camera_runner import intrusion_rule
    assert intrusion_rule(dict(RULE, minMovePx=40)).min_motion_px == 40
    assert intrusion_rule(dict(RULE, minMovePx=0)).min_motion_px == 0
    assert intrusion_rule({k: v for k, v in RULE.items() if k != 'minMovePx'}).min_motion_px == 10      # old rules get it too
    registry.put_camera(CAM)
    registry.put_rule(dict(RULE, minMovePx=40))
    assert registry.runner('CAM-1').rules[0]['minMovePx'] == 40
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, minMovePx=-5))


FIRE_RULE = dict(id='R-F', name='Smoke or flame', cameraIds=['CAM-1'], zoneIds=[], subject='any', condition='smoke',
                 minFrames=4, minConfidence=0.3, repeatSec=60, fireClasses='both', schedule='always', mode='live', priority='P1')


def test_fire_and_smoke_rules_run_for_real(registry):
    registry.put_camera(CAM)
    registry.put_rule(FIRE_RULE)
    assert [r['id'] for r in FakeRunner.instances[-1].rules] == ['R-F']
    assert registry.rules['R-F']['fireClasses'] == 'both'


def test_other_conditions_stay_simulated(registry):
    registry.put_camera(CAM)
    registry.put_rule(dict(FIRE_RULE, id='R-X', condition='no-ppe'))
    assert all(r['id'] != 'R-X' for r in FakeRunner.instances[-1].rules)


def test_a_fire_rule_with_bad_settings_is_refused(registry):
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(FIRE_RULE, minFrames=12))
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(FIRE_RULE, fireClasses='gas'))


def _runner(zones):
    from qavach.camera_runner import CameraRunner
    runner = CameraRunner.__new__(CameraRunner)
    runner.camera = dict(id='CAM-1', zones=zones, source=Source('stream', url='x'))
    runner.recent = []
    return runner


def test_fire_engines_use_the_fire_watch_zones_the_rule_picked_and_every_ignore_zone():
    square = [[10, 10], [60, 10], [60, 60], [10, 60]]
    zones = [dict(id='W', name='Workshop', purpose='fire-watch', kind='polygon', points=square),
             dict(id='I', name='Exhaust', purpose='fire-ignore', kind='polygon', points=[[70, 10], [90, 10], [90, 30], [70, 30]]),
             dict(id='R', name='Restricted', purpose='restricted', kind='polygon', points=square)]
    runner = _runner(zones)
    runner.rules = [dict(FIRE_RULE, zoneIds=['W'])]
    (engine, _), = runner._build_fire_engines(1000, 1000)
    assert [z.id for z in engine.watch] == ['W'] and [z.id for z in engine.ignore] == ['I']
    # a restricted area is not a watch area: a fire rule that picked only that has nothing to watch
    runner.rules = [dict(FIRE_RULE, zoneIds=['R'])]
    assert runner._build_fire_engines(1000, 1000) == []
    # no zones picked: the whole view, minus the ignore areas
    runner.rules = [dict(FIRE_RULE, zoneIds=[])]
    (engine, _), = runner._build_fire_engines(1000, 1000)
    assert engine.watch == [] and [z.id for z in engine.ignore] == ['I']


def test_fire_alert_events_serialise_to_json_and_carry_the_hazard(tmp_path, monkeypatch):
    import json

    import numpy as np

    monkeypatch.setattr(config, 'SNAPSHOTS', tmp_path)
    runner = _runner([])
    events = []
    runner.stats, runner.emit = dict(alerts=0), events.append
    runner._fire_alert(np.zeros((720, 1280, 3), dtype=np.uint8), dict(id='R-F', mode='live'),
                       dict(hazard='smoke', confidence=0.62, box=[128.0, 72.0, 256.0, 144.0], frames=5, dwell=0.6, repeat=False,
                            zone_id=None, zone_name=None), 1280, 720)
    json.dumps(events[0])
    assert events[0]['hazard'] == 'smoke' and events[0]['box'] == [10.0, 10.0, 10.0, 10.0] and events[0]['zoneName'] == 'the camera view'


def test_engines_for_people_and_vehicle_rules_are_built_per_camera_and_the_region_follows_them():
    from qavach.camera_runner import detection_region, wants
    from qavach.zonerules import VEHICLE_ID_OFFSET

    zone = dict(id='A', name='Area', purpose='restricted', kind='polygon', points=[[40, 40], [60, 40], [60, 60], [40, 60]])
    line = dict(id='L', name='Gate', purpose='line', kind='line', points=[[50, 0], [50, 100]])
    runner = _runner([zone, line])
    runner.rules = [dict(RULE, id='E', zoneIds=['A']), dict(RULE, id='F', condition='dwells', zoneIds=['A']),
                    dict(RULE, id='X', condition='crosses', zoneIds=['L']), dict(RULE, id='N', condition='no-ppe'),
                    dict(FIRE_RULE), dict(RULE, id='D', condition='crosses', zoneIds=['A'])]
    engines = runner._build_engines(1000, 1000)
    assert [rule['id'] for _, rule in engines] == ['E', 'F', 'X']          # no-ppe and fire are not people engines; D has no line
    assert detection_region(engines[:2], 1000, 1000)[2] - detection_region(engines[:2], 1000, 1000)[0] < 500
    runner.rules = [dict(RULE, id='O', condition='outside', zoneIds=['A'])]
    assert detection_region(runner._build_engines(1000, 1000), 1000, 1000) == (0, 0, 1000, 1000)       # outside: anywhere in the picture
    assert wants('person', 5) and not wants('person', VEHICLE_ID_OFFSET + 5) and wants('vehicle', VEHICLE_ID_OFFSET + 5)
    assert not wants('vehicle', 5) and wants('any', 5) and wants('any', VEHICLE_ID_OFFSET + 5)


def test_the_new_conditions_run_for_real_and_keep_their_settings(registry):
    registry.put_camera(CAM)
    extras = dict(speeding=dict(speedKmh=25, metersAcross=50), fewer=dict(minPeople=3), wrongway=dict(allowedDir=-1),
                  tailgate=dict(gapSec=4), near=dict(nearPx=100), running=dict(runSpeed=1.4), abandoned=dict(ownerPx=200),
                  phone=dict(), absent=dict(), down=dict())
    for condition, extra in extras.items():
        registry.put_rule(dict(RULE, id=f'R-{condition}', condition=condition, **extra))
        stored = registry.rules[f'R-{condition}']
        assert all(stored[k] == v for k, v in extra.items())
        assert reg.supported(stored)
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-bad', condition='speeding'))           # no limit or scale
    with pytest.raises(reg.Invalid):
        registry.put_rule(dict(RULE, id='R-bad2', condition='wrongway'))          # no allowed direction
