"""Short clips of incidents, saved when an alert is raised and shown beside its snapshot.

A camera on a video file is cut straight from that file around the moment of the alert, so the clip plays at the video's own
speed. A live camera has no past to cut from, so its clip is made from the pictures the service kept of the last few
seconds (one per analysed frame), which plays slower. Clips are small H.264 files that any browser plays.
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from qavach import config

BEFORE_SECONDS = 4.0
AFTER_SECONDS = 4.0
WIDTH = 640

_FFMPEG = shutil.which('ffmpeg')


def _encode_args():
    return ['-an', '-vf', f'scale={WIDTH}:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']


def clip_path(event_id):
    return config.CLIPS / f'{event_id}.mp4'


def from_file(video, position, event_id):
    """Cut the seconds around `position` (seconds into the video) out of a video file. True when the clip was written."""
    if not _FFMPEG or not video:
        return False
    config.CLIPS.mkdir(parents=True, exist_ok=True)
    start = max(0.0, float(position) - BEFORE_SECONDS)
    result = subprocess.run([_FFMPEG, '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', str(video), '-t', f'{BEFORE_SECONDS + AFTER_SECONDS:.2f}',
                             *_encode_args(), str(clip_path(event_id))], capture_output=True, timeout=90)
    return result.returncode == 0 and clip_path(event_id).exists()


def from_frames(jpegs, event_id, fps=3):
    """Make a clip from kept pictures (JPEG bytes, oldest first). True when the clip was written."""
    if not _FFMPEG or len(jpegs) < 2:
        return False
    config.CLIPS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        for i, data in enumerate(jpegs):
            (Path(folder) / f'{i:04d}.jpg').write_bytes(data)
        result = subprocess.run([_FFMPEG, '-v', 'error', '-y', '-framerate', str(fps), '-i', str(Path(folder) / '%04d.jpg'),
                                 *_encode_args(), str(clip_path(event_id))], capture_output=True, timeout=90)
    return result.returncode == 0 and clip_path(event_id).exists()
