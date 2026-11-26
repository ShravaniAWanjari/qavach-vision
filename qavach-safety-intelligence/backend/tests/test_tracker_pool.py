"""Cameras share tracker processes: a fake worker speaks the same messages, so no BoxMOT or GPU is needed here."""
import struct
import sys

import numpy as np
import pytest

from qavach import config, detector

FAKE = r'''
import os, struct, sys
out, inp = sys.stdout.buffer, sys.stdin.buffer
def read(n):
    b = b''
    while len(b) < n:
        c = inp.read(n - len(b))
        if not c: sys.exit(0)
        b += c
    return b
keys = {}
while True:
    k = read(1)
    if k == b'Q': sys.exit(0)
    if k == b'R':
        key, fps = struct.unpack('<if', read(8)); keys[key] = 0; out.write(b'K')
    elif k == b'D':
        key = struct.unpack('<i', read(4))[0]; keys.pop(key, None); out.write(b'K')
    elif k == b'U':
        key, h, w, n = struct.unpack('<iiii', read(16)); read(n * 24); read(h * w * 3)
        if key not in keys: sys.exit(3)                       # a camera that was never started: the worker dies
        keys[key] += 1
        # one track whose id carries the key and how many frames this key has had, so cameras can be told apart
        out.write(struct.pack('<i', 1) + struct.pack('<8f', 0, 0, 1, 1, key * 1000 + keys[key], 1, 0, 0))
    out.flush()
'''


@pytest.fixture
def fake_worker(tmp_path, monkeypatch):
    worker = tmp_path / 'fake_worker.py'
    worker.write_text(FAKE)
    weights = tmp_path / 'reid.pt'
    weights.write_bytes(b'x')
    monkeypatch.setattr(config, 'TRACKER_PYTHON', __import__('pathlib').Path(sys.executable))
    monkeypatch.setattr(config, 'TRACKER_WORKER', worker)
    monkeypatch.setattr(config, 'REID_WEIGHTS', weights)
    monkeypatch.setattr(config, 'TRACKER_CAMERAS', 2)
    detector._POOL.clear()
    yield
    for p in list(detector._POOL):
        p.stop()
    detector._POOL.clear()


FRAME = np.zeros((4, 4, 3), dtype=np.uint8)
DETS = np.zeros((0, 6), dtype=np.float32)


def test_cameras_share_a_process_up_to_the_limit_and_keep_their_own_tracks(fake_worker):
    a, b, c = detector.TrackerClient(), detector.TrackerClient(), detector.TrackerClient()
    for t in (a, b, c):
        t.reset(25)
    assert a.process is b.process and c.process is not a.process        # two cameras per process here
    ida = [a.update(FRAME, DETS)[0, 4] for _ in range(3)]
    idb = b.update(FRAME, DETS)[0, 4]
    assert ida == [a.key * 1000 + 1, a.key * 1000 + 2, a.key * 1000 + 3] and idb == b.key * 1000 + 1
    for t in (a, b, c):
        t.close()
    assert detector._POOL == []                                            # the last camera gone: the process is stopped


def test_a_process_is_stopped_only_when_its_last_camera_leaves(fake_worker):
    a, b = detector.TrackerClient(), detector.TrackerClient()
    a.reset(25)
    b.reset(25)
    proc = a.process
    a.close()
    assert proc.poll() is None and b.update(FRAME, DETS).shape == (1, 8)
    b.close()
    proc.wait(timeout=3)
    assert proc.poll() is not None


def test_a_dead_worker_fails_its_cameras_and_the_next_camera_gets_a_new_one(fake_worker):
    a = detector.TrackerClient()
    a.reset(25)
    a.process.kill()
    a.process.wait(timeout=3)
    with pytest.raises(RuntimeError):
        a.update(FRAME, DETS)
    b = detector.TrackerClient()                                           # the camera reconnects
    b.reset(25)
    assert b.process is not a.process and b.update(FRAME, DETS).shape == (1, 8)
    a.close()
    b.close()
