"""Where the back-end finds its models and helper environments.

The detector and tracker weights live in the port-safety project (`barge-intrusion`), so the defaults point there.
Every path can be overridden with an environment variable, so the back-end can run from any machine that has the files.
"""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent          # backend/
DATA = Path(os.environ.get('QAVACH_DATA', HERE / 'data'))
FRAMES = DATA / 'frames'            # one still per "test connection", shown while the zones are drawn
UPLOADS = DATA / 'uploads'
SEED = HERE / 'seed'                # the cameras, rules and alert pictures the site ships with (state.json, snapshots/); see server startup
SAMPLES = HERE / 'samples'          # demo videos shipped with the service; copied into UPLOADS at start so cameras can name them by id
CLIPS = DATA / 'clips'              # a short clip of each incident, saved when its alert is raised
SNAPSHOTS = DATA / 'snapshots'      # the frame each alert was raised on
STATE_FILE = DATA / 'state.json'    # cameras and rules, so a restart does not forget them
# Run only these cameras (comma separated ids, e.g. QAVACH_ONLY_CAMERAS=DCK-83); every other camera stays saved but is not analysed.
# For testing one camera on a busy machine: the cameras share the detector, so fewer cameras means more frames for each.
ONLY_CAMERAS = {c.strip() for c in os.environ.get('QAVACH_ONLY_CAMERAS', '').split(',') if c.strip()}

PORT_SAFETY = Path(os.environ.get('QAVACH_PORT_SAFETY', Path.home() / 'Documents' / 'port-safety '))
BARGE = PORT_SAFETY / 'barge-intrusion'

# The two weight files are kept in backend/weights/ (the Docker image uses them); the port-safety copies are the fallback.
BUNDLED = HERE / 'weights'
YOLO_WEIGHTS = Path(os.environ.get('QAVACH_YOLO_WEIGHTS', BUNDLED / 'yolo11s.pt' if (BUNDLED / 'yolo11s.pt').exists() else BARGE / 'yolo11s.pt'))
_REID = 'reid/osnet_ain_x1_0_msmt17.pt'
REID_WEIGHTS = Path(os.environ.get('QAVACH_REID_WEIGHTS', BUNDLED / _REID if (BUNDLED / _REID).exists() else BARGE / 'weights' / _REID))
FIRE_WEIGHTS = Path(os.environ.get('QAVACH_FIRE_WEIGHTS', BUNDLED / 'dfire-yolov8n.pt' if (BUNDLED / 'dfire-yolov8n.pt').exists() else PORT_SAFETY / 'YOLOv8-Fire-and-Smoke-Detection/models/dfire-yolov8n.pt'))
POSE_WEIGHTS = Path(os.environ.get('QAVACH_POSE_WEIGHTS', BUNDLED / 'yolo11s-pose.pt'))
TRACKER_PYTHON = Path(os.environ.get('QAVACH_TRACKER_PYTHON', BARGE / '.venv-boxmot/bin/python'))
TRACKER_WORKER = Path(__file__).with_name('tracker_worker.py')
# Cameras that share one tracker process. Each process holds PyTorch and the re-identification model once (about
# 0.3 to 0.5 GB); its cameras take turns, so more cameras per process saves memory and fewer keeps them from waiting.
TRACKER_CAMERAS = max(1, int(os.environ.get('QAVACH_TRACKER_CAMERAS', 8)))

# Tallest stream the back-end asks YouTube for. Pedestrians in the ferry camera are about half as tall at 720p.
MAX_STREAM_HEIGHT = int(os.environ.get('QAVACH_MAX_HEIGHT', 1080))
# DEMO ONLY. Any rtsp:// address typed for a camera is served from this YouTube live link instead, so a demo can show
# the steps of connecting a camera without a real RTSP camera on the network. The console still shows what was typed.
# Set QAVACH_DEMO_RTSP_URL to an empty value to turn it off and open real RTSP addresses.
DEMO_RTSP_URL = os.environ.get('QAVACH_DEMO_RTSP_URL', 'https://www.youtube.com/live/QO-hO_kwwmY').strip()
# Detection runs on the area around the drawn zones, resized so its long side is at most this many pixels: 1280 on a GPU.
# A server with no GPU uses CPU_DETECT_SIZE, as a pass at 1280 costs it seconds; QAVACH_DETECT_SIZE sets it either way.
_DETECT_SIZE_SET = os.environ.get('QAVACH_DETECT_SIZE', '').strip()
DETECT_SIZE = int(_DETECT_SIZE_SET or 1280)
CPU_DETECT_SIZE = 960
# People counting looks again in tiles of the picture (crowdcount.py), one detector pass per tile. On a GPU every tile is looked at
# every frame (0 = all); with no GPU only this many a frame, in turn, the others keeping their last result, as a crowd changes
# slowly. QAVACH_TILES_PER_FRAME sets it either way.
_TILES_SET = os.environ.get('QAVACH_TILES_PER_FRAME', '').strip()
CPU_TILES_PER_FRAME = 1


def on_cpu():
    """Whether the models run on the CPU (no GPU found, or QAVACH_DEVICE=cpu)."""
    from qavach.device import pick_device
    return pick_device() == 'cpu'


def detect_size_limit():
    return DETECT_SIZE if _DETECT_SIZE_SET or not on_cpu() else CPU_DETECT_SIZE


def tiles_per_frame():
    return int(_TILES_SET) if _TILES_SET else CPU_TILES_PER_FRAME if on_cpu() else 0
# The live preview is downscaled to this width before it is JPEG-encoded.
PREVIEW_WIDTH = int(os.environ.get('QAVACH_PREVIEW_WIDTH', 960))

# Folder holding the built console (npm run build). When set and present, the service serves it at / so one address
# gives the whole site; the Docker image does this. Unset when the console runs on its own (npm run dev).
WEB = Path(os.environ['QAVACH_WEB']) if os.environ.get('QAVACH_WEB') else None

MAX_UPLOAD_BYTES = 2 * 1024 ** 3
VIDEO_SUFFIXES = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v')
MAX_EVENTS = 300            # alerts kept in memory for the page to fetch
