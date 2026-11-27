"""The live view: pictures are made only while someone watches, boxes go out as data, and clips still show the boxes."""
import threading
import time

import cv2
import numpy as np

from qavach import config
from qavach.camera_runner import (CLIP_FPS, RED, CameraRunner, LiveReader, annotate, draw_overlay, overlay_of)
from qavach.sources import Source
from qavach.zonerules import VEHICLE_ID_OFFSET


def bare_runner(live=True, detecting=True):
    r = CameraRunner.__new__(CameraRunner)
    r.camera = dict(id='CAM-1', source=Source('stream', url='rtsp://x') if live else Source('upload', upload_id='a' * 12))
    r.stats = dict(detecting=detecting)
    r.jpeg = r.jpeg_overlay = r.overlay = None
    r.seq = r.overlay_seq = 0
    r.viewers, r.wanted_until, r._clip_at = 0, 0.0, 0.0
    from collections import deque
    r.recent = deque(maxlen=24)
    r.stop_flag = threading.Event()
    return r


FRAME = np.full((1080, 1920, 3), 90, dtype=np.uint8)


def sample_overlay():
    rows = [(3, 192.0, 108.0, 384.0, 540.0, 0.9), (VEHICLE_ID_OFFSET + 2, 960.0, 540.0, 1920.0, 1080.0, 0.8), (9, 0.0, 0.0, 10.0, 10.0, 0.5)]
    return overlay_of(FRAME, 12.3456, rows, flagged={3}, inside={9}, labels={3: 'dwells'},
                      fires=[('smoke', 0.62, (100.0, 100.0, 200.0, 300.0), 'counted'), ('fire', 0.4, (0.0, 0.0, 50.0, 50.0), 'ignored')],
                      notes=[(960.0, 540.0, '7 / 6 people', RED)])


def test_boxes_go_out_as_fractions_of_the_picture_with_their_state_and_label():
    o = sample_overlay()
    assert (o['t'], o['w'], o['h']) == (12.346, 1920, 1080)
    assert o['boxes'][0] == [0.1, 0.1, 0.2, 0.5, 'flagged', '#3 dwell']
    assert o['boxes'][1][4:] == ['seen', '']                   # not flagged: no label
    assert o['boxes'][2][4] == 'inside'
    assert o['fires'][0][4:] == ['smoke', 'SMOKE 62%'] and o['fires'][1][4:] == ['ignored', '']
    assert o['notes'] == [[0.5, 0.5, '7 / 6 people', 'alert']]


def test_the_same_overlay_draws_onto_a_picture_of_any_size():
    small = draw_overlay(np.zeros((180, 320, 3), dtype=np.uint8), sample_overlay())
    assert small[18:90, 32].any()                               # the flagged box's left edge, scaled to the small picture
    clip_frame = annotate(cv2.imencode('.jpg', np.zeros((360, 640, 3), dtype=np.uint8))[1].tobytes(), sample_overlay())
    assert cv2.imdecode(np.frombuffer(clip_frame, np.uint8), cv2.IMREAD_COLOR).any()


def test_nobody_watching_means_no_live_picture_but_the_boxes_still_go_out():
    r = bare_runner()
    r._publish(FRAME, 1.0, sample_overlay())
    assert r.jpeg is None and r.seq == 0
    assert r.overlay['seq'] == 1 and r.overlay['boxes']


def test_an_open_stream_makes_the_picture_without_boxes_drawn_on_it():
    r = bare_runner()
    with r.watch():
        r._publish(FRAME, 1.0, sample_overlay())
        picture = cv2.imdecode(np.frombuffer(r.jpeg, np.uint8), cv2.IMREAD_COLOR)
        assert picture.shape[1] == config.PREVIEW_WIDTH
        assert np.abs(picture.astype(int) - 90).max() < 6         # plain picture: no box drawn into it
        assert r.jpeg_overlay is r.overlay
    assert r.viewers == 0 and not r.watched()


def test_a_still_request_keeps_pictures_coming_for_a_few_seconds():
    r = bare_runner()
    r.want_frame()
    assert r.watched()
    r.wanted_until = time.time() - 1
    assert not r.watched()


def test_a_live_camera_with_rules_keeps_small_clip_pictures_a_few_times_a_second_unwatched():
    r = bare_runner(live=True, detecting=True)
    r._publish(FRAME, 0.0, sample_overlay())
    r._publish(FRAME, 0.1, sample_overlay())                     # too soon for another clip picture
    assert len(r.recent) == 1
    data, overlay = r.recent[0]
    assert cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR).shape[1] == 640 and overlay['boxes']
    r._clip_at -= 1.0 / CLIP_FPS
    r._publish(FRAME, 0.3, sample_overlay())
    assert len(r.recent) == 2


def test_a_file_or_a_camera_without_rules_keeps_no_clip_pictures():
    for live, detecting in ((False, True), (True, False)):
        r = bare_runner(live=live, detecting=detecting)
        r._publish(FRAME, 0.0, sample_overlay())
        assert not r.recent


class CountingCapture:
    def __init__(self, frames=10_000):
        self.frames, self.at, self.reads, self.grabs, self.seeks = frames, 0, 0, 0, []

    def get(self, prop):
        return self.frames if prop == cv2.CAP_PROP_FRAME_COUNT else 0

    def set(self, prop, value):
        self.seeks.append(value)
        self.at = int(value)

    def grab(self):
        self.grabs += 1
        self.at += 1
        return self.at <= self.frames

    def read(self):
        self.reads += 1
        self.at += 1
        return self.at <= self.frames, np.zeros((4, 4, 3), dtype=np.uint8)

    def release(self):
        pass


def test_an_unwatched_file_camera_without_rules_does_not_read_the_file_and_resumes_in_place():
    r = bare_runner(live=False, detecting=False)
    capture = CountingCapture()
    frames = r._file_frames(capture, 25.0, detecting=False)
    stopper = threading.Timer(0.35, r.want_frame)
    stopper.start()
    _, seconds = next(frames)                                    # waits, unread, until someone asks for a picture
    stopper.join()
    assert capture.reads == 1 and capture.grabs == 0
    assert capture.seeks and capture.seeks[0] >= 5               # it picked up the video where its clock had got to
    assert seconds >= 0.2


def test_the_live_reader_keeps_nothing_while_idle():
    capture = CountingCapture(frames=60)
    reader = LiveReader(capture, 25.0, keep_seconds=3, keep_fps=12, idle=lambda: True)
    reader.run()
    assert capture.reads == 0 and not reader.buffer and reader.count == 60
    capture = CountingCapture(frames=60)
    reader = LiveReader(capture, 25.0, keep_seconds=3, keep_fps=12, idle=lambda: False)
    reader.run()
    assert len(reader.buffer) == 30 and capture.grabs == 30          # every other frame kept
