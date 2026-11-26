"""BoxMOT BoT-SORT + OSNet-AIN tracking worker for the demo server.

Run with .venv-boxmot (the main venv has no BoxMOT). The server sends frames and detections over stdin and
reads tracks from the original stdout; anything the libraries print goes to stderr instead so it cannot corrupt
the binary stream.

One worker serves several cameras. Each camera has its own tracker (its own tracks and ids), keyed by a number the
server picks; all of them share one re-identification model, so the PyTorch runtime and the model are in memory once
instead of once per camera (about 0.3 to 0.5 GB saved for each camera after the first). Messages (little endian):

  b'R' + int32 key + float32 fps                              -> b'K'                     (start a fresh tracker for key)
  b'U' + int32 key + int32 h, w, n + n*6 float32 + h*w*3 BGR  -> int32 m + m*8 float32   (tracks: x1 y1 x2 y2 id conf cls det)
  b'D' + int32 key                                            -> b'K'                     (forget the tracker of key)
  b'Q'                                                        -> exit
"""
import os
import struct
import sys
from pathlib import Path

import numpy as np

# Same thresholds as config/tracker.reappearance-reid.yaml and scripts/boxmot_track.py.
TRACKER_OPTIONS = dict(track_high_thresh=0.05, track_low_thresh=0.01, new_track_thresh=0.05,
                       track_buffer=180, match_thresh=0.8, proximity_thresh=0.5,
                       appearance_thresh=0.25, use_cmc=False)


def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return bytes(data)


def main():
    reid_weights = Path(sys.argv[1])
    out = os.fdopen(os.dup(1), 'wb', buffering=0)
    os.dup2(2, 1)
    stdin = sys.stdin.buffer

    from boxmot import BotSort
    try:
        from qavach.device import half_precision, pick_device
    except ImportError:         # started as a script by path, so the package is not on sys.path; its folder is
        from device import half_precision, pick_device
    # Re-identification runs on Apple's GPU too: it gives the same tracks as the CPU (checked on three scenes, identical
    # identities) and is 7 to 9 times faster with many people in view. QAVACH_TRACKER_MPS=0 puts it back on the CPU.
    device = pick_device(allow_mps=os.environ.get('QAVACH_TRACKER_MPS', '1') != '0')
    trackers, shared = {}, {'reid': None}

    def fresh(fps):
        tracker = BotSort(reid_weights=reid_weights, device=device, half=half_precision(device), use_embeddings=True,
                          frame_rate=max(1, int(round(fps))), **TRACKER_OPTIONS)
        if shared['reid'] is not None:
            tracker._reid_model = shared['reid']     # BoxMOT builds the model on first use; hand it the one already built
        return tracker

    while True:
        try:
            kind = read_exact(stdin, 1)
        except EOFError:
            return
        if kind == b'Q':
            return
        if kind == b'R':
            key, fps = struct.unpack('<if', read_exact(stdin, 8))
            trackers[key] = fresh(fps)
            out.write(b'K')
        elif kind == b'D':
            key = struct.unpack('<i', read_exact(stdin, 4))[0]
            trackers.pop(key, None)
            out.write(b'K')
        elif kind == b'U':
            key, height, width, count = struct.unpack('<iiii', read_exact(stdin, 16))
            dets = np.frombuffer(read_exact(stdin, count * 24), dtype='<f4').reshape(count, 6).copy()
            frame = np.frombuffer(read_exact(stdin, height * width * 3), dtype=np.uint8).reshape(height, width, 3)
            tracker = trackers[key]
            if shared['reid'] is not None and getattr(tracker, '_reid_model', None) is None:
                tracker._reid_model = shared['reid']     # a tracker started before the model was built picks it up now
            tracks = np.ascontiguousarray(np.asarray(tracker.update(dets, frame)).reshape(-1, 8), dtype='<f4')
            if shared['reid'] is None and getattr(tracker, '_reid_model', None) is not None:
                shared['reid'] = tracker._reid_model
            out.write(struct.pack('<i', len(tracks)) + tracks.tobytes())

if __name__ == '__main__':
    main()
