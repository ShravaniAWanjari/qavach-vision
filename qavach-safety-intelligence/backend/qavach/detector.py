"""People and vehicle detection (YOLO11s, this process) and tracking (BoxMOT BoT-SORT with OSNet ReID, a worker process).

The settings are the ones the port-safety project settled on for small, distant pedestrians (docs/FINAL_APPROACH.md in
barge-intrusion): person class only, a very low confidence floor so nobody is lost, and the rule decides what is
confident enough to alert on."""
import itertools
import struct
import subprocess
import threading

import numpy as np

from qavach import config
from qavach.device import half_precision, pick_device

# Apple's GPU (mps) crashes when two models encode work on it at once from different threads ("A command encoder is already
# encoding to this command buffer"), so on mps every model shares one lock. CUDA and the CPU keep a lock per model.
_MPS_LOCK = threading.Lock()


def _lock_for(device):
    return _MPS_LOCK if str(device).startswith('mps') else threading.Lock()


def load_model(weights, device, task='detect', imgsz=960):
    """(model, 'openvino' or 'pytorch'): the YOLO model for `weights`. On the CPU, the OpenVINO version of it when the openvino package is installed: about
    1.5 to 3 times faster than PyTorch on a CPU, with the same detections. It is made once from the weights (a few seconds)
    and kept under DATA/models; any problem, or QAVACH_OPENVINO=off, falls back to the PyTorch model."""
    import os
    import shutil
    from pathlib import Path
    from ultralytics import YOLO
    weights = Path(weights)
    if device != 'cpu' or os.environ.get('QAVACH_OPENVINO', '').strip().lower() in ('0', 'off', 'false', 'no'):
        return YOLO(str(weights), task=task), 'pytorch'
    try:
        import openvino  # noqa: F401
    except ImportError:
        return YOLO(str(weights), task=task), 'pytorch'
    try:
        home = config.DATA / 'models'
        stem = f'{weights.stem}-{int(weights.stat().st_mtime)}'
        built = home / f'{stem}_openvino_model'
        if not (built / 'metadata.yaml').exists():
            home.mkdir(parents=True, exist_ok=True)
            work = home / f'{stem}.pt'
            shutil.copyfile(weights, work)          # the export is written next to the weights it is made from
            YOLO(str(work), task=task).export(format='openvino', imgsz=imgsz, dynamic=True, half=False, verbose=False)
            work.unlink(missing_ok=True)
        model = YOLO(str(built), task=task)
        print(f'{weights.name}: running with OpenVINO on the CPU', flush=True)
        return model, 'openvino'
    except Exception as error:                                                                          # noqa: BLE001
        print(f'{weights.name}: OpenVINO not used ({type(error).__name__}: {error}); running with PyTorch', flush=True)
        return YOLO(str(weights), task=task), 'pytorch'


class Detector:
    """One model shared by every camera; calls are serialised because the GPU is shared too."""

    def __init__(self):
        from ultralytics import YOLO
        if not config.YOLO_WEIGHTS.exists():
            raise FileNotFoundError(f'{config.YOLO_WEIGHTS} is missing; set QAVACH_YOLO_WEIGHTS or see README.md')
        self.device = pick_device()
        self.half = half_precision(self.device)
        self.model, self.runtime = load_model(config.YOLO_WEIGHTS, self.device, imgsz=config.detect_size_limit())
        self.lock = _lock_for(self.device)
        self.detect(np.zeros((360, 640, 3), dtype=np.uint8), 640)        # warm up the GPU kernels

    def detect(self, frame, size, classes=(0,), conf=0.05):
        """Boxes in `frame` as an (n, 6) float32 array: x1 y1 x2 y2 confidence class. `classes` are COCO ids: 0 is a person,
        2, 3, 5 and 7 are the vehicles. One pass finds all of them, so a camera that watches people and vehicles pays once.
        `conf` is the lowest confidence kept. The network takes about 10 ms; removing overlapping boxes after it is most of the
        time of a pass (120 ms at 0.05 in a crowd, 40 ms at 0.3), so a caller that throws away everything below 0.3 anyway
        (crowd counting, vehicles) says so. Boxes at or above `conf` come out the same whatever it is: a weak box never
        removes a stronger one."""
        with self.lock:          # reading results off the GPU is GPU work too: it stays inside the lock (mps crashes otherwise)
            result = self.model.predict(frame, conf=conf, iou=0.45, imgsz=size, device=self.device, half=self.half,
                                        classes=list(classes), verbose=False)[0]
            boxes = result.boxes
            if len(boxes) == 0:
                return np.zeros((0, 6), dtype=np.float32)
            xyxy = boxes.xyxy.cpu().numpy()
            conf = boxes.conf.cpu().numpy()[:, None]
            cls = boxes.cls.cpu().numpy()[:, None]
        return np.concatenate([xyxy, conf, cls], axis=1).astype(np.float32)


class FireDetector:
    """D-Fire YOLOv8n: finds fire and smoke in a frame. No tracking is needed: the fire rule asks whether a class keeps
    showing up (fire.py), not which flame is which. The detector keeps everything above a low floor; the rule's
    "sure" setting decides what counts, and the preview shows what did not as a thin grey box."""
    NAMES = {0: 'smoke', 1: 'fire'}       # class order of the D-Fire checkpoint
    FLOOR = 0.10
    SIZE = 960

    def __init__(self):
        from ultralytics import YOLO
        if not config.FIRE_WEIGHTS.exists():
            raise FileNotFoundError(f'{config.FIRE_WEIGHTS} is missing; set QAVACH_FIRE_WEIGHTS or see README.md')
        self.device = pick_device()
        self.half = half_precision(self.device)
        self.model, self.runtime = load_model(config.FIRE_WEIGHTS, self.device, imgsz=self.SIZE)
        self.lock = _lock_for(self.device)
        self.detect(np.zeros((540, 960, 3), dtype=np.uint8))          # warm up the GPU kernels

    def detect(self, frame):
        """[(class name, confidence, (x1, y1, x2, y2))] with plain floats, so the results can go straight into JSON."""
        with self.lock:          # results are read off the GPU inside the lock too
            result = self.model.predict(frame, conf=self.FLOOR, imgsz=self.SIZE, device=self.device, half=self.half, verbose=False)[0]
            boxes = result.boxes
            if len(boxes) == 0:
                return []
            rows = list(zip(boxes.xyxy.cpu().numpy().tolist(), boxes.conf.cpu().numpy().tolist(), boxes.cls.cpu().numpy().astype(int).tolist()))
        return [(self.NAMES[cls], float(conf), tuple(float(v) for v in box)) for box, conf, cls in rows if cls in self.NAMES]


class PoseDetector:
    """YOLO11s-pose: the 17 body keypoints of every person in a frame, for the person-down rule. It runs only for cameras that
    have such a rule, on the people the tracker already found (the runner matches each pose to a track by box overlap)."""

    def __init__(self):
        from ultralytics import YOLO
        if not config.POSE_WEIGHTS.exists():
            raise FileNotFoundError(f'{config.POSE_WEIGHTS} is missing; set QAVACH_POSE_WEIGHTS or see README.md')
        self.device = pick_device(allow_mps=False)       # Ultralytics: pose models misread keypoints on Apple's GPU backend
        self.half = half_precision(self.device)
        self.model = YOLO(str(config.POSE_WEIGHTS))
        self.lock = _lock_for(self.device)
        self.detect(np.zeros((360, 640, 3), dtype=np.uint8), 640)

    def detect(self, frame, size):
        """[(box (x1, y1, x2, y2), keypoints 17x3 as x, y, confidence)] for the people in `frame`."""
        with self.lock:
            result = self.model.predict(frame, conf=0.25, imgsz=size, device=self.device, half=self.half, verbose=False)[0]
            if result.keypoints is None or len(result.boxes) == 0:
                return []
            boxes = result.boxes.xyxy.cpu().numpy()
            kps = np.concatenate([result.keypoints.xy.cpu().numpy(), result.keypoints.conf.cpu().numpy()[..., None]], axis=2)
        return [(tuple(float(v) for v in b), k.astype(float)) for b, k in zip(boxes, kps)]


class _TrackerProcess:
    """One tracker_worker.py process. It serves up to TRACKER_CAMERAS cameras, one request at a time."""

    def __init__(self):
        for path in (config.TRACKER_PYTHON, config.REID_WEIGHTS):
            if not path.exists():
                raise FileNotFoundError(f'{path} is missing; set QAVACH_TRACKER_PYTHON / QAVACH_REID_WEIGHTS or see README.md')
        self.process = subprocess.Popen([str(config.TRACKER_PYTHON), str(config.TRACKER_WORKER), str(config.REID_WEIGHTS)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.lock = threading.Lock()       # a request and its answer go together: cameras on this process take turns
        self.users = 0
        self.dead = False

    def ask(self, payload, answer):
        """Send `payload` (bytes or a list of buffers) and return what `answer(read)` reads back."""
        with self.lock:
            if self.dead:
                raise RuntimeError('tracker worker exited; check the back-end console')
            try:
                for part in (payload if isinstance(payload, list) else [payload]):
                    self.process.stdin.write(part)
                self.process.stdin.flush()
                return answer(self._read)
            except (BrokenPipeError, OSError, RuntimeError) as error:
                self.dead = True            # the cameras on it reconnect, and get a new process
                raise RuntimeError('tracker worker exited; check the back-end console') from error

    def _read(self, count):
        data = self.process.stdout.read(count)
        if len(data) != count:
            raise RuntimeError('tracker worker exited')
        return data

    def stop(self):
        with self.lock:
            try:
                self.process.stdin.write(b'Q')
                self.process.stdin.flush()
                self.process.wait(timeout=3)
            except Exception:
                self.process.kill()
            self.dead = True


_POOL, _POOL_LOCK, _KEYS = [], threading.Lock(), itertools.count(1)


class TrackerClient:
    """The tracker of one camera. Cameras share tracker_worker.py processes (QAVACH_TRACKER_CAMERAS each, 8 by default)
    instead of starting one each: a worker holds PyTorch and the re-identification model once, about 0.3 to 0.5 GB, so a
    process per camera cost that much memory again for every camera. Each camera keeps its own tracks and ids."""

    def __init__(self):
        with _POOL_LOCK:
            _POOL[:] = [p for p in _POOL if not p.dead]
            proc = next((p for p in _POOL if p.users < config.TRACKER_CAMERAS), None)
            if proc is None:
                proc = _TrackerProcess()
                _POOL.append(proc)
            proc.users += 1
        self.proc, self.key, self.closed = proc, next(_KEYS), False

    def reset(self, fps):
        if self.proc.ask(b'R' + struct.pack('<if', self.key, fps), lambda read: read(1)) != b'K':
            raise RuntimeError('tracker worker did not acknowledge reset')

    def update(self, frame, dets):
        """Tracks as an (m, 8) array: x1 y1 x2 y2 track_id confidence class detection_index."""
        height, width = frame.shape[:2]
        dets = np.ascontiguousarray(dets, dtype='<f4').reshape(-1, 6)

        def answer(read):
            count = struct.unpack('<i', read(4))[0]
            return np.frombuffer(read(count * 32), dtype='<f4').reshape(count, 8)
        return self.proc.ask([b'U' + struct.pack('<iiii', self.key, height, width, len(dets)) + dets.tobytes(),
                              np.ascontiguousarray(frame).data], answer)

    @property
    def process(self):
        return self.proc.process

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.proc.ask(b'D' + struct.pack('<i', self.key), lambda read: read(1))
        except RuntimeError:
            pass
        with _POOL_LOCK:
            self.proc.users -= 1
            if self.proc.users <= 0:          # the last camera on it has gone: free its memory
                if self.proc in _POOL:
                    _POOL.remove(self.proc)
                self.proc.stop()
