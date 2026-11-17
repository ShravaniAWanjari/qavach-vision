"""Person collapse alert: someone who was upright is now on the floor and stays there.

Pure logic, no models: it takes one person's pose keypoints per frame (YOLO11-pose's 17 COCO points) and a timestamp,
and says when the person has gone down and when they have stayed down. It is unit-tested on its own (tests/test_collapse.py)
and scored on fall videos by eval_falls.py.

Three cues, all in body proportions (torso lengths), so none depends on the camera or the picture size:

  * lean     the shoulder-to-hip line, in degrees from vertical (0 upright, 90 lying flat);
  * drop     how far the hips have fallen below where they were while the person stood (in torso lengths);
  * reach    the person's height against their tallest recent height (a lying person is much shorter than a standing one).

A person is "down" when they lean past `lean_down` AND (their hips have dropped OR they are much shorter than before). The
second part is what separates a fall from bending over to pick something up (a lean with the hips still high). Pose
models read a person lying on the floor as only partly flat (on the URFD falls the median lean was 37-86 degrees), so a body
that has dropped AND is far shorter than before also counts, from a lean of `lean_floor` up.

States: up -> down -> collapsed. "down" starts the moment the cues say so; "collapsed" is raised once they have stayed
down `collapse_seconds` (they have not got up). Getting back to upright for `recover_seconds` clears it. Both timers are
short demo values; a real installation would use longer ones.
"""
from collections import deque
from dataclasses import dataclass

import numpy as np

NOSE, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_ANKLE, R_ANKLE = 0, 5, 6, 11, 12, 15, 16
VISIBLE = 0.30


@dataclass
class Settings:
    lean_down: float = 55.0            # degrees from vertical past which the body counts as lying
    lean_up: float = 35.0              # degrees from vertical below which the body counts as upright
    hip_drop: float = 0.45             # torso lengths the hips must fall below their standing height to count as down
    short_ratio: float = 0.62          # or: height under this share of the recent tallest height
    flat_ratio: float = 0.55           # a body this short AND dropped counts as lying even when the pose model reads a modest lean
    lean_floor: float = 30.0           # ...but only from this lean: a crouch or a squat stays upright
    baseline_seconds: float = 6.0      # how far back "where they stood" reaches
    down_seconds: float = 0.6          # cues must hold this long before the person counts as down (filters a stumble)
    collapse_seconds: float = 3.0      # down this long without getting up: collapsed (demo value)
    recover_seconds: float = 1.5       # upright this long: back to normal


def body(keypoints):
    """(lean degrees, hip y, torso length, height) from 17x3 keypoints, or None when the trunk cannot be seen."""
    k = np.asarray(keypoints, dtype=float)
    if np.isnan(k).any():
        return None
    shoulders = [k[i, :2] for i in (L_SHOULDER, R_SHOULDER) if k[i, 2] >= VISIBLE]
    hips = [k[i, :2] for i in (L_HIP, R_HIP) if k[i, 2] >= VISIBLE]
    if not shoulders or not hips:
        return None
    s, h = np.mean(shoulders, axis=0), np.mean(hips, axis=0)
    trunk = h - s
    length = float(np.linalg.norm(trunk))
    if length < 4.0:
        return None
    lean = float(np.degrees(np.arctan2(abs(trunk[0]), max(abs(trunk[1]), 1e-6))))
    seen = k[k[:, 2] >= VISIBLE]
    height = float(seen[:, 1].max() - seen[:, 1].min())
    return lean, float(h[1]), length, height


class Collapse:
    def __init__(self, settings=None):
        self.s = settings or Settings()
        self.history = deque()           # (t, hip_y, height) while upright
        self.state = 'up'
        self.down_since = self.up_since = self.cue_since = None
        self.last_upright = None
        self.took = None
        self.alerts = 0

    def baseline(self, t):
        rows = [r for r in self.history if t - r[0] <= self.s.baseline_seconds]
        if not rows:
            return None
        return float(np.median([r[1] for r in rows])), float(max(r[2] for r in rows))

    def update(self, t, keypoints):
        """Returns (state, events). Events: 'down' when the person goes down, 'collapsed' when they stay down."""
        events = []
        b = None if keypoints is None else body(keypoints)
        if b is None:
            return self.state, events                     # nothing readable: change nothing
        lean, hip_y, torso, height = b
        base = self.baseline(t)
        dropped = base is not None and (hip_y - base[0]) / torso >= self.s.hip_drop
        short = base is not None and height <= self.s.short_ratio * base[1]
        flat = base is not None and height <= self.s.flat_ratio * base[1]
        lying = (lean >= self.s.lean_down and (dropped or short)) or (lean >= self.s.lean_floor and dropped and flat)
        upright = lean <= self.s.lean_up and not dropped
        if upright:
            self.last_upright = t
            self.history.append((t, hip_y, height))
            while self.history and t - self.history[0][0] > 3 * self.s.baseline_seconds:
                self.history.popleft()
        if self.state == 'up':
            self.cue_since = (self.cue_since if self.cue_since is not None else t) if lying else None
            if lying and t - self.cue_since >= self.s.down_seconds:
                self.state, self.down_since, self.up_since = 'down', self.cue_since, None
                # How long they took to get from upright to down: a fall is quick, lying down on purpose is not.
                took = None if self.last_upright is None else self.down_since - self.last_upright
                self.took = took
                events.append(dict(type='down', seconds=t, since=self.down_since, took=took))
        else:
            self.up_since = (self.up_since if self.up_since is not None else t) if upright else None
            if self.up_since is not None and t - self.up_since >= self.s.recover_seconds:
                self.state, self.down_since, self.cue_since, self.up_since = 'up', None, None, None
            elif self.state == 'down' and self.up_since is None and t - self.down_since >= self.s.collapse_seconds:
                self.state = 'collapsed'
                self.alerts += 1
                events.append(dict(type='collapsed', seconds=t, since=self.down_since, took=self.took))
        return self.state, events
