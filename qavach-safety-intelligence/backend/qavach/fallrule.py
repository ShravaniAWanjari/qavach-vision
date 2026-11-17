"""Person down (man down): someone who was upright goes to the floor and stays there.

The judgement is in collapse.py (pose keypoints in, "up / down / collapsed" out, no model of its own). This engine runs one
`Collapse` per tracked person and turns "collapsed" into an alert, in the same shape as the other engines in zonerules and
moverules. The camera runner sets `engine.pose` before each update: {track id: 17x3 keypoints} for the people the pose model
found this frame; a person with no pose this frame is simply not updated (collapse.py changes nothing on an unreadable frame).
"""
from dataclasses import dataclass, field

import numpy as np

from qavach.collapse import Collapse, Settings
from qavach.intrusion import FORGET_AFTER_SECONDS
from qavach.moverules import _in_zones
from qavach.zonerules import WHOLE_VIEW, _foot


@dataclass
class _Person:
    collapse: Collapse
    last_seen: float = 0.0
    peak: float = 0.0
    frames: int = 0
    last_alert: float = None
    alerts: int = 0


class CollapseRule:
    kind = 'down'
    subject = 'person'

    def __init__(self, zones, rule, scale=1.0):
        self.zones, self.rule, self.scale = zones, rule, scale
        self.settings = Settings(collapse_seconds=rule.dwell_seconds)
        self.state, self.alert_count, self.suppressed_count = {}, 0, 0
        self.pose = {}

    @property
    def watch_points(self):
        return np.concatenate([z.points for z in self.zones])

    def update(self, seconds, tracks):
        """The alert comes once the person has been down for the rule's time and has not got up; `dwell` is how long they have
        been down. A person who falls and gets up inside that time raises nothing."""
        info, events = {}, []
        rule = self.rule
        for tid, x1, y1, x2, y2, conf in tracks:
            tid = int(tid)
            st = self.state.setdefault(tid, _Person(Collapse(self.settings)))
            st.last_seen, st.peak = seconds, max(st.peak, float(conf))
            st.frames += 1
            zone = _in_zones(self.zones, _foot(x1, y1, x2, y2))
            keypoints = self.pose.get(tid)
            if zone is None or keypoints is None or st.peak < rule.min_confidence or st.frames < rule.min_frames:
                info[tid] = dict(zone=zone.id if zone else None, inside=zone is not None, flagged=st.collapse.state == 'collapsed',
                                 moved=True, waiting=st.collapse.state == 'down')
                continue
            state, found = st.collapse.update(seconds, keypoints)
            for e in found:
                if e['type'] != 'collapsed':
                    continue
                if st.last_alert is not None and seconds - st.last_alert < rule.repeat_seconds:
                    self.suppressed_count += 1
                    continue
                st.alerts += 1
                st.last_alert = seconds
                self.alert_count += 1
                events.append(dict(type='alert', id=tid, seconds=seconds, zone_id=zone.id, zone_name=zone.name,
                                   confidence=round(st.peak, 3), reentry=st.alerts > 1, dwell=round(seconds - e['since'], 2),
                                   frames=st.frames, moved=0.0))
            info[tid] = dict(zone=zone.id, inside=True, flagged=state == 'collapsed', moved=True, waiting=state == 'down')
        for tid, st in list(self.state.items()):
            if seconds - st.last_seen > FORGET_AFTER_SECONDS:
                del self.state[tid]
        return info, events
