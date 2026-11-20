"""Fleet test: N cameras at once on the real service, to see what the machine really sustains.

Starts the service on its own port with its own empty data folder, gives it N cameras (each a looping video with the
rules of one camera profile) and, after a warm-up, measures for a while: the frames each camera really analysed, the CPU the
service and its tracker workers used, their memory, and (on a Mac) the GPU's busy share. Then it stops the service.

    pip install psutil
    $PY backend/tools/capacity_fleet.py OUT.json --cameras 30 --profile ICF --seconds 120
    $PY backend/tools/capacity_fleet.py OUT.json --cameras 10 --profile IF,IC,IP,CG       # profiles are used in turn

Cameras read video files, which the service plays in real time and skips frames of when it falls behind: the frames a camera
analyses per second is how much the machine could keep up with. A live camera also costs a decode and a JPEG compression of
every frame, which this test does not include: add them from `capacity_bench.py ingest`.
Profiles: I intrusion, C people count, G crowd gathering, F fire and smoke, P phone (one letter each, any combination).
Run it on an idle machine; stop everything else that uses the GPU or many cores first.
"""
import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import psutil

HERE = Path(__file__).resolve().parent.parent
D = Path.home() / 'Downloads'
VIDEOS = [D / 'gemini_generated_video_3c0d59ea.mp4', D / '16669591_1920_1080_25fps.mp4', D / '15149844_1920_1080_30fps.mp4']   # few, some, many people
FULL = [[1, 1], [99, 1], [99, 99], [1, 99]]
RULES = {
    'I': ('z1', dict(condition='enters', subject='person', durationSec=1, minFrames=3, minConfidence=0.3, minMovePx=10)),
    'C': ('z1', dict(condition='crowd', subject='person', durationSec=3, crowdOver=10, minFrames=2, minConfidence=0.3)),
    'G': ('z1', dict(condition='gathering', subject='person', durationSec=4, minPeople=6, minFrames=2, minConfidence=0.3)),
    'F': ('f1', dict(condition='smoke', subject='any', durationSec=0, minFrames=4, minConfidence=0.3, fireClasses='both')),
    'P': ('z1', dict(condition='phone', subject='any', durationSec=2, minFrames=2, minConfidence=0.3, phoneConfidence=0.35)),
}


def call(port, path, body=None, method=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None,
                                     method=method or ('POST' if body is not None else 'GET'), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def gpu_busy():
    """The GPU's busy share in percent on a Mac (ioreg, no sudo); None elsewhere (use nvidia-smi on a server)."""
    try:
        out = subprocess.run(['ioreg', '-r', '-d', '1', '-c', 'AGXAccelerator'], capture_output=True, text=True, timeout=5).stdout
        found = re.search(r'"Device Utilization %"=(\d+)', out)
        return int(found.group(1)) if found else None
    except Exception:                                                                                   # noqa: BLE001
        return None


def tree(proc):
    try:
        return [proc] + proc.children(recursive=True)
    except psutil.Error:
        return [proc]


def cpu_and_memory(procs):
    cpu, rss = 0.0, 0
    for p in procs:
        try:
            t = p.cpu_times()
            cpu += t.user + t.system
            rss += p.memory_info().rss
        except psutil.Error:
            pass
    return cpu, rss / 2 ** 20


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--cameras', type=int, default=10)
    ap.add_argument('--profile', default='ICF', help='use cases of every camera; comma separated profiles are used in turn')
    ap.add_argument('--seconds', type=int, default=120, help='measuring time')
    ap.add_argument('--warmup', type=int, default=60)
    ap.add_argument('--port', type=int, default=8841)
    ap.add_argument('--device', default=os.environ.get('QAVACH_DEVICE', ''))
    args = ap.parse_args()
    profiles = args.profile.split(',')
    work = Path(args.out).resolve().parent / f'fleet_data_{args.cameras}_{args.profile.replace(",", "-")}'
    shutil.rmtree(work, ignore_errors=True)
    (work / 'uploads').mkdir(parents=True)
    for i, v in enumerate(VIDEOS):
        shutil.copy(v, work / 'uploads' / f'f1e1d000{i:04x}.mp4')
    env = dict(os.environ, QAVACH_DATA=str(work))
    if args.device:
        env['QAVACH_DEVICE'] = args.device
    py = os.environ.get('QAVACH_PYTHON', str(Path.home() / 'Documents' / 'port-safety ' / 'barge-intrusion' / '.venv' / 'bin' / 'python'))
    log = open(work / 'service.log', 'w')
    service = subprocess.Popen([py, '-m', 'qavach.server', '--port', str(args.port)], cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT)
    proc = psutil.Process(service.pid)
    try:
        for _ in range(120):
            try:
                call(args.port, '/api/health')
                break
            except Exception:                                                                           # noqa: BLE001
                time.sleep(1)
        cameras, rules = [], []
        for n in range(args.cameras):
            cam = f'CAM-{n + 1:02d}'
            profile = profiles[n % len(profiles)]
            cameras.append(dict(id=cam, name=cam, source=dict(kind='upload', uploadId=f'f1e1d000{n % len(VIDEOS):04x}', everyFrame=False),
                                zones=[dict(id=f'{cam}-z1', name='Zone', purpose='restricted', kind='polygon', points=FULL),
                                       dict(id=f'{cam}-f1', name='Watch', purpose='fire-watch', kind='polygon', points=FULL)]))
            for c in profile:
                zone, rule = RULES[c]
                rules.append(dict(rule, id=f'R-{cam}-{c}', name=c, cameraIds=[cam], zoneIds=[f'{cam}-{zone}'], repeatSec=60, mode='live'))
        problems = call(args.port, '/api/sync', dict(cameras=cameras, rules=rules, replace=True))['problems']
        print('sync problems:', problems, flush=True)
        time.sleep(args.warmup)
        samples = []
        start_frames = {k: v.get('frames', 0) for k, v in call(args.port, '/api/events?since=0')['cameras'].items()}
        procs = tree(proc)
        cpu0, _ = cpu_and_memory(procs)
        wall0 = time.time()
        gpu, rss_samples, states = [], [], []
        while time.time() - wall0 < args.seconds:
            time.sleep(5)
            procs = tree(proc)
            _, rss = cpu_and_memory(procs)
            rss_samples.append(rss)
            g = gpu_busy()
            if g is not None:
                gpu.append(g)
            statuses = call(args.port, '/api/events?since=0')['cameras']
            states.append({k: v.get('state') for k, v in statuses.items()})
            samples.append(dict(t=round(time.time() - wall0), rss_mb=round(rss), gpu=g, bg=psutil.cpu_percent(interval=None)))
        wall = time.time() - wall0
        cpu1, rss = cpu_and_memory(tree(proc))
        statuses = call(args.port, '/api/events?since=0')['cameras']
        per_camera = {k: round((v.get('frames', 0) - start_frames.get(k, 0)) / wall, 2) for k, v in statuses.items()}
        fps = sorted(per_camera.values())
        result = dict(cameras=args.cameras, profile=args.profile, measured_seconds=round(wall), warmup_seconds=args.warmup,
                      per_camera_fps=per_camera, fps_min=fps[0], fps_median=statistics.median(fps), fps_mean=round(statistics.mean(fps), 2), fps_max=fps[-1],
                      total_fps=round(sum(fps), 2), cpu_cores=round((cpu1 - cpu0) / wall, 2), rss_mb_end=round(rss), rss_mb_max=round(max(rss_samples)),
                      worker_processes=len(tree(proc)) - 1, gpu_busy_mean=round(statistics.mean(gpu), 1) if gpu else None,
                      gpu_busy_max=max(gpu) if gpu else None, camera_states=sorted({s for st in states for s in st.values() if s}), samples=samples,
                      sync_problems=problems, device=args.device or 'default', logical_cpus=os.cpu_count())
        Path(args.out).write_text(json.dumps(result, indent=1))
        print(json.dumps({k: v for k, v in result.items() if k not in ('per_camera_fps', 'samples')}, indent=1), flush=True)
    finally:
        for p in tree(proc):
            try:
                p.kill()
            except psutil.Error:
                pass
        log.close()


if __name__ == '__main__':
    sys.exit(main())
