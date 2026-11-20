"""Capacity benchmark: what one camera costs per use case, on this machine. Run it on the machine you plan to deploy on and
paste the numbers into the capacity workbook (docs/Qavach-Capacity-Model.xlsx), so the sizing uses that hardware, not ours.

    PY=<the service's python>
    QAVACH_DEVICE=cuda  $PY backend/tools/capacity_bench.py pipeline OUT.json            # GPU
    QAVACH_DEVICE=cpu   $PY backend/tools/capacity_bench.py pipeline OUT.json --quick    # no GPU: slow, fewer cases
    $PY backend/tools/capacity_bench.py ingest OUT.json [--streams 30]                    # decode + JPEG cost of the video itself

`pipeline` times the real per-frame code (CameraRunner._process: detector, fire model, pose, tracker, rules) for every
combination of use cases on videos with few, some, many and very many people, and splits the time by stage.
`ingest` times what the service does to every frame of a live stream before analysing any (decode, JPEG-compress), at several
resolutions, and then with N streams at 25 frames a second at once to see what that costs in CPU cores.
Run it on an otherwise idle machine: it records the load the machine had, so a noisy run can be told from a clean one.

Videos: pass --videos DIR to use your own (names below), or edit SCENES. The defaults are the ones the numbers in the
workbook were taken on.
"""
import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from qavach import config, sources                                                          # noqa: E402
from qavach.camera_runner import CameraRunner, detection_region, needs_tracker              # noqa: E402
from qavach.detector import Detector, FireDetector, PoseDetector, TrackerClient             # noqa: E402

D = Path.home() / 'Downloads'
FULL = [[1, 1], [99, 1], [99, 99], [1, 99]]
SAMPLE_FPS = 2.0                 # frames are taken 0.5 s apart in the video
SCENES = {                       # tier -> (label, video)
    'S': ('quiet: 1 person', D / 'gemini_generated_video_3c0d59ea.mp4'),
    'M': ('moderate: about 20 people', D / '16669591_1920_1080_25fps.mp4'),
    'H': ('busy: 50+ people', D / '15149844_1920_1080_30fps.mp4'),
    'X': ('dense: 100+ people', Path(os.environ.get('QAVACH_DENSE_VIDEO', D / 'dense_crossing.mp4'))),
}

USE_CASES = {                    # code -> (name, zone it uses, console rule)
    'I': ('People intrusion', 'z1', dict(condition='enters', subject='person', durationSec=1, minFrames=3, minConfidence=0.3, minMovePx=10)),
    'C': ('People count', 'z1', dict(condition='crowd', subject='person', durationSec=3, crowdOver=10, minFrames=2, minConfidence=0.3)),
    'G': ('Crowd gathering', 'z1', dict(condition='gathering', subject='person', durationSec=4, minPeople=6, minFrames=2, minConfidence=0.3)),
    'F': ('Fire and smoke', 'f1', dict(condition='smoke', subject='any', durationSec=0, minFrames=4, minConfidence=0.3, fireClasses='both')),
    'P': ('Phone usage', 'z1', dict(condition='phone', subject='any', durationSec=2, minFrames=2, minConfidence=0.3, phoneConfidence=0.35)),
}
PROFILES = ['I', 'C', 'G', 'F', 'P', 'IF', 'IC', 'IP', 'CG', 'ICF', 'IPF', 'CGF']      # which use cases one camera runs
QUICK = ['I', 'C', 'F', 'P', 'ICF']


def background_cpu():
    """CPU (percent of one core) used by everything that is not this program, from ps: a noisy machine shows up here."""
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,pcpu='], capture_output=True, text=True).stdout.split('\n')
    rows = [tuple(float(x) for x in line.split()) for line in out if line.strip()]
    mine, grew = {os.getpid()}, True
    while grew:
        grew = False
        for pid, ppid, _ in rows:
            if ppid in mine and pid not in mine:
                mine.add(pid)
                grew = True
    return round(sum(c for pid, _, c in rows if pid not in mine and pid != os.getpid()), 1)


def rss_mb(pid):
    out = subprocess.run(['ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    return round(int(out) / 1024, 1) if out else None


def machine():
    info = dict(platform=platform.platform(), python=sys.version.split()[0], cpu_count=os.cpu_count(), load_average=os.getloadavg())
    try:
        import torch
        import ultralytics
        info.update(torch=torch.__version__, ultralytics=ultralytics.__version__, cuda=torch.cuda.is_available(),
                    mps=bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available()))
    except Exception as error:                                                                          # noqa: BLE001
        info['torch_error'] = str(error)
    info['opencv'] = cv2.__version__
    if sys.platform == 'darwin':
        info['cpu_model'] = subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True, text=True).stdout.strip()
        info['memory_gb'] = round(int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout) / 2 ** 30, 1)
    return info


def frames_of(path, n):
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, round(fps / SAMPLE_FPS))
    i, out = 0, []
    while len(out) < n:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            out.append((i / fps, frame))
        i += 1
    return out


class Timers:
    def __init__(self):
        self.t = {}

    def wrap(self, obj, name, label):
        orig = getattr(obj, name)

        def timed(*a, **k):
            start = time.perf_counter()
            try:
                return orig(*a, **k)
            finally:
                self.t[label] = self.t.get(label, 0.0) + time.perf_counter() - start
        setattr(obj, name, timed)

    def take(self):
        out, self.t = self.t, {}
        return out


def run_profile(profile, tier, models, frames_wanted, warm):
    det, fire_det, pose_det = models
    label, video = SCENES[tier]
    frames = frames_of(video, frames_wanted + warm)
    height, width = frames[0][1].shape[:2]
    zones = [dict(id='z1', name='Zone', purpose='restricted', kind='polygon', points=FULL),
             dict(id='f1', name='Watch', purpose='fire-watch', kind='polygon', points=FULL)]
    rules = [dict(USE_CASES[c][2], id=f'R-{c}', zoneIds=[USE_CASES[c][1]], repeatSec=60, mode='live') for c in profile]
    runner = CameraRunner.__new__(CameraRunner)
    runner.camera = dict(id='BENCH', zones=zones, source=sources.Source('stream', url='x'))
    runner.rules = rules
    runner.stats = dict(alerts=0, fps=SAMPLE_FPS, people=0, vehicles=0)
    runner.recent, runner.loop_offset, runner.seq, runner.vehicle_tracker, runner.object_tracker, runner.detect_classes = [], 0.0, 0, None, None, (0,)
    runner._clip = lambda event_id: None
    runner.emit = lambda event: None
    engines = runner._build_engines(width, height)
    fire_engines = runner._build_fire_engines(width, height)
    needs = runner._prepare(engines) if engines else set()
    runner.pose_detector = pose_det if 'pose' in needs else None
    tracker, tracker_rss = None, None
    if engines and 'person' in needs and needs_tracker(engines):
        tracker = TrackerClient()
        tracker.reset(SAMPLE_FPS)
    region = detection_region(engines, width, height) if engines else None
    timers = Timers()
    timers.wrap(det, 'detect', 'detector')
    if fire_engines:
        timers.wrap(fire_det, 'detect', 'fire_model')
    if runner.pose_detector is not None:
        timers.wrap(pose_det, 'detect', 'pose')
    if tracker is not None:
        timers.wrap(tracker, 'update', 'tracker')
    totals, cpus, parts, people = [], [], [], []
    background = background_cpu()
    try:
        for k, (t, frame) in enumerate(frames):
            runner.file_pos = t
            timers.take()
            start, cpu0 = time.perf_counter(), time.process_time()
            rows, _ = runner._process(frame, t, engines, tracker, det, region, width, height, fire_engines, fire_det if fire_engines else None)
            elapsed, cpu = time.perf_counter() - start, time.process_time() - cpu0
            p = timers.take()
            if k == warm and tracker is not None:
                tracker_rss = rss_mb(tracker.process.pid)
            if k >= warm:
                totals.append(elapsed * 1000)
                cpus.append(cpu * 1000)
                parts.append({a: b * 1000 for a, b in p.items()})
                people.append(sum(1 for r in rows if r[0] < 1_000_000))
    finally:
        for obj in (det, fire_det, pose_det):
            if obj is not None and 'detect' in obj.__dict__:
                del obj.__dict__['detect']
        if tracker is not None:
            tracker.close()
    keys = sorted({k for p in parts for k in p})
    ordered = sorted(totals)
    return dict(profile=profile, tier=tier, scene=label, size=f'{width}x{height}', frames=len(totals),
                mean_ms=round(statistics.mean(totals), 1), median_ms=round(statistics.median(totals), 1),
                p95_ms=round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1), max_ms=round(max(totals), 1),
                process_cpu_ms=round(statistics.mean(cpus), 1),
                parts_ms={k: round(statistics.mean(p.get(k, 0.0) for p in parts), 1) for k in keys},
                people_boxes=round(statistics.mean(people), 1) if people else 0, tracker_rss_mb=tracker_rss,
                background_cpu_pct=background, background_cpu_after_pct=background_cpu())


def cmd_pipeline(args):
    out = Path(args.out)
    config.SNAPSHOTS = out.parent / 'bench_snaps'
    config.SNAPSHOTS.mkdir(exist_ok=True)
    before = rss_mb(os.getpid())
    det, fire_det, pose_det = Detector(), FireDetector(), PoseDetector()
    models = (det, fire_det, pose_det)
    info = dict(machine=machine(), detector_device=str(det.device), fire_device=str(fire_det.device), pose_device=str(pose_det.device),
                detect_size=config.DETECT_SIZE, frames=args.frames, warm=args.warm, background_cpu_start=background_cpu(),
                service_rss_mb_models_loaded=rss_mb(os.getpid()), rss_mb_before_models=before)
    profiles = args.profiles.split(',') if args.profiles else (QUICK if args.quick else PROFILES)
    tiers = args.tiers.split(',') if args.tiers else ['S', 'M', 'H', 'X']
    results = []
    run_profile('IPF', 'M', models, 4, 2)                               # throw-away run so every model's kernels are compiled
    for profile in profiles:
        for tier in tiers:
            if not SCENES[tier][1].exists():
                print('missing video', SCENES[tier][1])
                continue
            res = run_profile(profile, tier, models, args.frames, args.warm)
            results.append(res)
            print(f"{profile:4s} {tier} mean {res['mean_ms']:8.1f} ms p95 {res['p95_ms']:8.1f} cpu {res['process_cpu_ms']:7.1f} bg {res['background_cpu_pct']:6.1f}% parts {res['parts_ms']}", flush=True)
            out.write_text(json.dumps(dict(info=info, results=results), indent=1))
    info['background_cpu_end'] = background_cpu()
    out.write_text(json.dumps(dict(info=info, results=results), indent=1))
    print('DONE', flush=True)


# ── ingest: decoding and compressing the video of a live camera ─────────────────────────────────────────────────────
RESOLUTIONS = {'720p': (1280, 720), '1080p': (1920, 1080), '4 MP': (2560, 1440), '4K': (3840, 2160)}


def make_clip(path, size, seconds=6, fps=25):
    """An H.264 clip (what a camera sends) at `size`, made from real footage so the decoder has real work to do."""
    src = frames_of(SCENES['M'][1], 12)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'avc1'), fps, size)
    if not writer.isOpened():
        raise RuntimeError('this OpenCV cannot write H.264 (avc1); give --clips a folder of H.264 clips named 720p.mp4, 1080p.mp4, 4 MP.mp4, 4K.mp4')
    for i in range(seconds * fps):
        frame = cv2.resize(src[(i // 4) % len(src)][1], size, interpolation=cv2.INTER_AREA)
        writer.write(frame)
    writer.release()


def one_stream(path, stop, counter, quality, paced_fps=None):
    """What LiveReader does for one camera: read a frame, JPEG-compress it, keep it. Paced like a camera when `paced_fps`."""
    started, n = time.time(), 0
    cap = cv2.VideoCapture(str(path))
    while not stop.is_set():
        ok, frame = cap.read()
        if not ok:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            continue
        cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        counter[0] += 1
        n += 1
        if paced_fps:
            stop.wait(max(0.0, started + n / paced_fps - time.time()))
    cap.release()


def cmd_ingest(args):
    out = Path(args.out)
    work = out.parent / 'ingest_clips'
    work.mkdir(exist_ok=True)
    results = dict(machine=machine(), single=[], streams=[], background_cpu_start=background_cpu())
    for name, size in RESOLUTIONS.items():
        clip = Path(args.clips) / f'{name}.mp4' if args.clips else work / f'{name.replace(" ", "")}.mp4'
        if not clip.exists():
            make_clip(clip, size)
        # one stream, one thread, as fast as it will go: the cost of one frame
        cap = cv2.VideoCapture(str(clip))
        dec, enc, imdec, sizes = [], [], [], []
        for i in range(150):
            t0 = time.perf_counter()
            ok, frame = cap.read()
            t1 = time.perf_counter()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            ok, data = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            t2 = time.perf_counter()
            cv2.imdecode(np.frombuffer(data.tobytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
            t3 = time.perf_counter()
            if i >= 10:
                dec.append((t1 - t0) * 1000)
                enc.append((t2 - t1) * 1000)
                imdec.append((t3 - t2) * 1000)
                sizes.append(len(data) / 1024)
        cap.release()
        row = dict(resolution=name, size=f'{size[0]}x{size[1]}', decode_ms=round(statistics.median(dec), 2), jpeg_encode_ms=round(statistics.median(enc), 2),
                   jpeg_decode_ms=round(statistics.median(imdec), 2), jpeg_kb=round(statistics.mean(sizes), 0),
                   frame_buffer_mb_12s_at_25fps=round(statistics.mean(sizes) * 25 * 12 / 1024, 1))
        results['single'].append(row)
        print(row, flush=True)
        # N streams at 25 frames a second at once: CPU cores used (process CPU time over wall time)
        for n in args.streams:
            stop, counter = threading.Event(), [0]
            threads = [threading.Thread(target=one_stream, args=(clip, stop, counter, 92, 25.0), daemon=True) for _ in range(n)]
            wall0, cpu0 = time.time(), time.process_time()
            for t in threads:
                t.start()
            time.sleep(args.seconds)
            stop.set()
            for t in threads:
                t.join()
            wall, cpu = time.time() - wall0, time.process_time() - cpu0
            srow = dict(resolution=name, streams=n, achieved_fps_per_stream=round(counter[0] / wall / n, 2), cpu_cores=round(cpu / wall, 2),
                        cpu_cores_per_stream=round(cpu / wall / n, 3), background_cpu_pct=background_cpu())
            results['streams'].append(srow)
            print(srow, flush=True)
            out.write_text(json.dumps(results, indent=1))
    out.write_text(json.dumps(results, indent=1))
    print('DONE', flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pipeline')
    p.add_argument('out')
    p.add_argument('--frames', type=int, default=24, help='timed frames per case (after the warm-up frames)')
    p.add_argument('--warm', type=int, default=3)
    p.add_argument('--profiles', help='comma separated, e.g. I,IF,ICF (I intrusion, C count, G gathering, F fire and smoke, P phone)')
    p.add_argument('--tiers', help='comma separated of S,M,H,X')
    p.add_argument('--quick', action='store_true', help='fewer cases (for a machine with no GPU, where each frame takes seconds)')
    p.set_defaults(fn=cmd_pipeline)
    q = sub.add_parser('ingest')
    q.add_argument('out')
    q.add_argument('--streams', type=lambda s: [int(x) for x in s.split(',')], default=[1, 10, 30])
    q.add_argument('--seconds', type=int, default=20)
    q.add_argument('--clips', help='folder of H.264 clips named 720p.mp4, 1080p.mp4, 4 MP.mp4, 4K.mp4 (made here when absent)')
    q.set_defaults(fn=cmd_ingest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
