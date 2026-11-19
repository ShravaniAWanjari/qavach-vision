"""Try the people and vehicle rules on a video, offline: the real detector, tracker and camera-runner code, no service, no waiting
for real time.

    PY=barge-intrusion/.venv/bin/python
    $PY backend/tools/try_rules.py VIDEO CONFIG.json [--fps 8] [--from 0] [--to 60] [--out DIR]

VIDEO is a video file, or a MOT17 sequence folder (with img1/ and seqinfo.ini). CONFIG.json holds the camera's zones (percent of the
picture, as the console draws them) and the console rules to run:

    {"zones": [{"id": "z1", "name": "Quay", "purpose": "restricted", "kind": "polygon", "points": [[10,10],[60,10],[60,60]]}],
     "rules": [{"id": "R-1", "condition": "dwells", "subject": "person", "zoneIds": ["z1"], "durationSec": 5, "mode": "live"}]}

Prints every alert with its video time, and writes OUT/annotated.mp4 (boxes, zones, lines) and OUT/EV-*.jpg (the alert snapshots).
"""
import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qavach import config, sources                                    # noqa: E402
from qavach.camera_runner import CameraRunner, detect_size, detection_region, needs_tracker, schedule_active   # noqa: E402,F401
from qavach.detector import Detector, TrackerClient                  # noqa: E402
from qavach.zonerules import VehicleTracker, build_engine            # noqa: E402


def read_frames(source, fps, start, end):
    """(seconds, frame) at about `fps` a second between `start` and `end` seconds."""
    path = Path(source)
    if path.is_dir():
        ini = (path / 'seqinfo.ini').read_text()
        src_fps = float([l for l in ini.splitlines() if l.startswith('frameRate')][0].split('=')[1])
        names = sorted((path / 'img1').glob('*.jpg'))
        step = max(1, round(src_fps / fps))
        for i in range(0, len(names), step):
            t = i / src_fps
            if start <= t <= end:
                yield t, cv2.imread(str(names[i]))
        return
    cap = cv2.VideoCapture(str(path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, round(src_fps / fps))
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            return
        t = i / src_fps
        if t > end:
            return
        if i % step == 0 and t >= start:
            yield t, frame
        i += 1


def draw_zones(view, zones, scale):
    for z in zones:
        pts = np.array([[p[0] / 100 * view.shape[1], p[1] / 100 * view.shape[0]] for p in z['points']], dtype=np.int32)
        if z.get('kind') == 'line':
            cv2.polylines(view, [pts], False, (0, 255, 255), 2)
        else:
            cv2.polylines(view, [pts], True, (0, 200, 255), 1)
        cv2.putText(view, z['name'], tuple(pts[0] + [4, 14]), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('config', type=Path)
    ap.add_argument('--fps', type=float, default=8.0)
    ap.add_argument('--from', dest='start', type=float, default=0.0)
    ap.add_argument('--to', dest='end', type=float, default=1e9)
    ap.add_argument('--out', type=Path, default=Path('try_rules_out'))
    ap.add_argument('--title', default='', help='a line written across the top of the annotated video')
    args = ap.parse_args()
    cfg = json.loads(args.config.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    config.SNAPSHOTS = args.out                                        # alert pictures land here, not in the service's data folder

    frames = read_frames(args.video, args.fps, args.start, args.end)
    first = next(frames, None)
    if first is None:
        sys.exit('no frames')
    height, width = first[1].shape[:2]

    found = []
    runner = CameraRunner.__new__(CameraRunner)
    runner.camera = dict(id='CAM-X', zones=cfg['zones'], source=sources.Source('stream', url='x'))
    runner.rules = cfg['rules']
    runner.stats = dict(alerts=0, fps=args.fps, people=0, vehicles=0)
    runner.recent, runner.loop_offset, runner.seq, runner.vehicle_tracker, runner.object_tracker, runner.detect_classes = [], 0.0, 0, None, None, (0,)
    runner._clip = lambda event_id: None
    clock = {'t': 0.0}
    runner.emit = lambda event: found.append((clock['t'], event))
    engines = runner._build_engines(width, height)
    if not engines:
        sys.exit('no rule has anything to watch on these zones')
    for engine, rule in engines:
        print(f'rule {rule["id"]}: {engine.kind} on {engine.subject}s')
    needs = runner._prepare(engines)
    runner.pose_detector = None
    if 'pose' in needs:
        from qavach.detector import PoseDetector
        runner.pose_detector = PoseDetector()
    detector = Detector()
    tracker = None
    if 'person' in needs and needs_tracker(engines):
        tracker = TrackerClient()
        tracker.reset(args.fps)
    region = detection_region(engines, width, height)

    writer = None
    began, count, banner = time.time(), 0, ('', -1.0)
    for t, frame in [first] + list(frames):
        clock['t'] = t
        runner.file_pos = t
        before = len(found)
        runner._process(frame, t, engines, tracker, detector, region, width, height)
        for _, e in found[before:]:
            banner = (f'ALERT  {e["condition"]}: {e["zoneName"]}' + ''.join(f' ({k} {e[k]})' for k in ('count', 'limit', 'level', 'cue', 'scene') if k in e), t + 2.0)
        view = cv2.imdecode(np.frombuffer(runner.jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        draw_zones(view, cfg['zones'], view.shape[1] / width)
        if args.title:
            cv2.rectangle(view, (0, 0), (view.shape[1], 30), (0, 0, 0), -1)
            cv2.putText(view, args.title, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        if t <= banner[1]:
            cv2.rectangle(view, (0, 32), (view.shape[1], 60), (0, 0, 160), -1)
            cv2.putText(view, banner[0], (8, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(view, f't={t:5.1f}s', (8, view.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        if writer is None:
            writer = cv2.VideoWriter(str(args.out / 'annotated.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), args.fps, (view.shape[1], view.shape[0]))
        writer.write(view)
        count += 1
    writer.release()
    if tracker:
        tracker.close()
    print(f'\n{count} frames in {time.time() - began:.0f} s ({count / (time.time() - began):.1f} frames/s)')
    print(f'{len(found)} alerts')
    for t, e in found:
        extra = ''.join(f' {k}={e[k]}' for k in ('count', 'limit', 'direction', 'speed', 'distance', 'gap', 'level', 'cue', 'scene') if k in e)
        print(f'  t={t:6.1f}s  {e["ruleId"]:8} {e["condition"]:8} {e["subject"]:7} track {e["trackId"]:<4} zone "{e["zoneName"]}" '
              f'dwell {e["dwell"]:.1f}s conf {e["confidence"]:.2f}{extra}  {e["id"]}')


if __name__ == '__main__':
    main()
