"""QAVACH_ONLY_CAMERAS: the other cameras stay saved but are not analysed."""
from qavach import config, registry
from qavach.sources import Source


class StubRunner:
    def __init__(self, camera, rules, *args, **kwargs):
        self.camera, self.stopped = camera, False

    def stop(self):
        self.stopped = True


def cameras():
    return {cid: dict(id=cid, name=cid, zones=[], source=Source('upload', upload_id='5a3b1e000005')) for cid in ('A', 'B', 'C')}


def test_only_the_listed_cameras_run(monkeypatch):
    monkeypatch.setattr(registry, 'CameraRunner', StubRunner)
    monkeypatch.setattr(config, 'ONLY_CAMERAS', {'B'})
    reg = registry.Registry()
    reg.cameras = cameras()
    reg.reconcile(['A', 'B', 'C'])
    assert set(reg.runners) == {'B'} and len(reg.cameras) == 3


def test_everything_runs_when_nothing_is_listed(monkeypatch):
    monkeypatch.setattr(registry, 'CameraRunner', StubRunner)
    monkeypatch.setattr(config, 'ONLY_CAMERAS', set())
    reg = registry.Registry()
    reg.cameras = cameras()
    reg.reconcile(['A', 'B', 'C'])
    assert set(reg.runners) == {'A', 'B', 'C'}


def test_a_camera_already_running_is_stopped_when_it_is_paused(monkeypatch):
    monkeypatch.setattr(registry, 'CameraRunner', StubRunner)
    monkeypatch.setattr(config, 'ONLY_CAMERAS', set())
    reg = registry.Registry()
    reg.cameras = cameras()
    reg.reconcile(['A', 'B'])
    first = reg.runners['A'][1]
    monkeypatch.setattr(config, 'ONLY_CAMERAS', {'B'})
    reg.reconcile(['A', 'B'])
    assert first.stopped and set(reg.runners) == {'B'}
