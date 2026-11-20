"""How an uploaded video is fed to the rules: in real time with frames skipped when behind, or every frame (no skipping)."""
import threading
import time

import numpy as np

from qavach.camera_runner import CameraRunner
from qavach.sources import Source, source_from_dict


class FakeCapture:
    def __init__(self, frames):
        self.frames, self.at = frames, 0

    def grab(self):
        if self.at >= self.frames:
            return False
        self.at += 1
        return True

    def read(self):
        if self.at >= self.frames:
            return False, None
        self.at += 1
        return True, np.zeros((4, 4, 3), dtype=np.uint8)


def runner():
    r = CameraRunner.__new__(CameraRunner)
    r.stop_flag = threading.Event()
    return r


def consume(every_frame, frames=24, fps=60.0, work=0.05):
    """Frames the rules see when each takes `work` seconds to analyse, at a video rate far faster than that."""
    seen = []
    for _, seconds in runner()._file_frames(FakeCapture(frames), fps, True, every_frame):
        seen.append(seconds)
        time.sleep(work)
    return seen


def test_default_skips_frames_when_the_detector_is_behind():
    seen = consume(every_frame=False)
    assert 0 < len(seen) < 12                       # most of the 24 frames were skipped


def test_every_frame_skips_nothing_and_keeps_the_videos_own_times():
    seen = consume(every_frame=True)
    assert len(seen) == 24
    assert all(abs(t - i / 60.0) < 1e-9 for i, t in enumerate(seen))


def test_every_frame_never_runs_ahead_of_real_time():
    started = time.time()
    list(runner()._file_frames(FakeCapture(12), 20.0, True, True))        # 12 frames at 20 fps is 0.6 s of video
    assert time.time() - started >= 0.5


def test_the_setting_is_read_from_the_consoles_source(monkeypatch):
    from qavach import sources
    monkeypatch.setattr(sources, 'upload_path', lambda upload_id: '/some/video.mp4')       # the video exists
    assert source_from_dict(dict(kind='upload', uploadId='5a3b1e000005', everyFrame=True)).every_frame is True
    assert source_from_dict(dict(kind='upload', uploadId='5a3b1e000005')).every_frame is False
    assert Source('upload').every_frame is False
