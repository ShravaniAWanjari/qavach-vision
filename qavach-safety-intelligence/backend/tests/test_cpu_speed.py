"""Settings that keep a server with no GPU usable: a smaller detection picture, counting tiles looked at one a frame in
turn, and the detectors through OpenVINO. A GPU server keeps doing everything as before."""
import numpy as np

from qavach import config, crowdcount, detector


class CountingDetector:
    def __init__(self):
        self.calls = []

    def detect(self, frame, size, classes=(0,), conf=0.05):
        self.calls.append((frame.shape, size))
        return np.zeros((0, 6), dtype=np.float32)


class Holder:
    pass


def test_on_the_cpu_detection_is_smaller_and_tiles_go_one_a_frame(monkeypatch):
    monkeypatch.setattr(config, 'on_cpu', lambda: True)
    monkeypatch.setattr(config, '_DETECT_SIZE_SET', '')
    monkeypatch.setattr(config, '_TILES_SET', '')
    assert config.detect_size_limit() == config.CPU_DETECT_SIZE and config.tiles_per_frame() == 1
    det, cache, frame = CountingDetector(), Holder(), np.zeros((1080, 1920, 3), dtype=np.uint8)
    region = (0, 0, 1920, 1080)
    crowdcount.people_boxes(det, frame, region, [], cache=cache)          # first frame: every tile, to start the count
    assert len(det.calls) == 4 and all(size <= config.CPU_DETECT_SIZE for _, size in det.calls)
    det.calls.clear()
    for _ in range(4):                                                    # then one tile a frame, each in turn
        crowdcount.people_boxes(det, frame, region, [], cache=cache)
    assert len(det.calls) == 4 and len({shape for shape, _ in det.calls}) >= 1


def test_on_a_gpu_nothing_changes(monkeypatch):
    monkeypatch.setattr(config, 'on_cpu', lambda: False)
    monkeypatch.setattr(config, '_DETECT_SIZE_SET', '')
    monkeypatch.setattr(config, '_TILES_SET', '')
    assert config.detect_size_limit() == 1280 and config.tiles_per_frame() == 0
    det, cache, frame = CountingDetector(), Holder(), np.zeros((1080, 1920, 3), dtype=np.uint8)
    for _ in range(3):
        crowdcount.people_boxes(det, frame, (0, 0, 1920, 1080), [], cache=cache)
    assert len(det.calls) == 12                                           # every tile, every frame


def test_settings_override_the_cpu_choice(monkeypatch):
    monkeypatch.setattr(config, 'on_cpu', lambda: True)
    monkeypatch.setattr(config, '_DETECT_SIZE_SET', '1280')
    monkeypatch.setattr(config, 'DETECT_SIZE', 1280)
    monkeypatch.setattr(config, '_TILES_SET', '0')
    assert config.detect_size_limit() == 1280 and config.tiles_per_frame() == 0


def test_openvino_is_only_tried_on_the_cpu(monkeypatch, tmp_path):
    made = []
    monkeypatch.setattr('ultralytics.YOLO', lambda path, task=None: made.append(str(path)) or path)
    weights = tmp_path / 'm.pt'
    weights.write_bytes(b'x')
    assert detector.load_model(weights, 'cuda:0') == (str(weights), 'pytorch')
    monkeypatch.setenv('QAVACH_OPENVINO', 'off')
    assert detector.load_model(weights, 'cpu') == (str(weights), 'pytorch')
