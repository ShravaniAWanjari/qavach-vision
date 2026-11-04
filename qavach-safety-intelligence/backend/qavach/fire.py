"""The fire and smoke rule: a class has to keep showing up, in an area that matters, before anyone is told.

Fire and smoke are not about who is where, so the rule has no "restricted area". A camera's zones can have two other
purposes for it:

  fire-watch   an area where fire or smoke matters (a workshop, a reefer stack, a hazardous cargo bay). When a rule
               picks watch areas, only detections whose centre is inside one of them count. With none picked, the
               whole view counts.
  fire-ignore  an area where the detector keeps seeing fire or smoke that is normal (a steam vent, an exhaust stack, a
               flare, a chimney). Detections centred in one never count, whatever the rule picked.

The persistence test is the K-of-N rule from the fire project (scripts/temporal_filter.py): a class raises an alert when
it was seen in `min_hits` of the last `window` analysed frames, which removes one-frame glints. Each setting maps to a
field of the console's rule:

  classes        'both', 'fire' or 'smoke'
  min_confidence a detection counts only if the detector is at least this sure
  min_hits       K, the frames (of the last `window`) the class has to be seen in
  repeat_seconds after an alert, the same class raises no new one for this long (fire flickers)
  clear_seconds  the class counts as gone after this long without a persistent detection
"""
from collections import deque
from dataclasses import dataclass, field

from qavach.intrusion import ZonePx, locate

CLASSES = ('fire', 'smoke')
WINDOW = 8                 # analysed frames the persistence test looks back over


@dataclass
class FireRule:
    classes: str = 'both'
    min_confidence: float = 0.25
    min_hits: int = 4
    repeat_seconds: float = 120.0
    clear_seconds: float = 2.0
    window: int = WINDOW

    @classmethod
    def from_dict(cls, data):
        known = {k: data[k] for k in ('classes', 'min_confidence', 'min_hits', 'repeat_seconds', 'clear_seconds')
                 if data.get(k) is not None}
        rule = cls(**known)
        if (rule.classes not in ('both',) + CLASSES or not 0 <= rule.min_confidence <= 1
                or not 1 <= rule.min_hits <= rule.window or rule.repeat_seconds < 0 or rule.clear_seconds < 0):
            raise ValueError('Rule values out of range')
        return rule

    @property
    def watched(self):
        return CLASSES if self.classes == 'both' else (self.classes,)


@dataclass
class _Hazard:
    history: deque = field(default_factory=lambda: deque(maxlen=WINDOW))
    first_hit: float = None
    active: bool = False
    last_hit: float = -1e9
    last_alert: float = None
    alerts: int = 0
    best: tuple = None              # (confidence, box) of the most confident counted detection in the window


@dataclass
class FireEngine:
    rule: FireRule
    watch: list                     # ZonePx areas; empty means the whole view
    ignore: list                    # ZonePx areas whose detections never count
    state: dict = field(default_factory=dict)
    alert_count: int = 0
    suppressed_count: int = 0

    def __post_init__(self):
        self.state = {name: _Hazard(history=deque(maxlen=self.rule.window)) for name in self.rule.watched}

    def counts(self, name, confidence, box):
        """Whether one detection counts, and the watch area it is in (None for the whole view)."""
        if name not in self.state or confidence < self.rule.min_confidence:
            return False, None
        centre = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        if locate(self.ignore, centre) is not None:
            return False, None
        if not self.watch:
            return True, None
        zone = locate(self.watch, centre)
        return zone is not None, zone

    def update(self, seconds, detections):
        """detections: iterable of (class name, confidence, (x1, y1, x2, y2)) for one analysed frame.

        Returns (info, events). info[i] = 'counted' or 'ignored' for each detection, in order. Events:
        'alert' (a class became persistent) and 'suppressed' (it would have, but repeat suppression held it back),
        'cleared' (it went away)."""
        info, hits, events = [], {name: [] for name in self.state}, []
        for name, confidence, box in detections:
            ok, zone = self.counts(name, confidence, box)
            info.append('counted' if ok else 'ignored')
            if ok:
                hits[name].append((confidence, tuple(box), zone))
        for name, hazard in self.state.items():
            seen = hits[name]
            hazard.history.append(bool(seen))
            if seen:
                hazard.last_hit = seconds
                if hazard.first_hit is None:
                    hazard.first_hit = seconds
                best = max(seen, key=lambda h: h[0])
                if hazard.best is None or best[0] >= hazard.best[0]:
                    hazard.best = best
            persistent = sum(hazard.history) >= self.rule.min_hits
            if persistent and not hazard.active:
                hazard.active = True
                held = hazard.last_alert is not None and seconds - hazard.last_alert < self.rule.repeat_seconds
                if held:
                    self.suppressed_count += 1
                    events.append(dict(type='suppressed', hazard=name, seconds=seconds))
                else:
                    hazard.last_alert = seconds
                    hazard.alerts += 1
                    self.alert_count += 1
                    confidence, box, zone = hazard.best
                    events.append(dict(type='alert', hazard=name, seconds=seconds, confidence=round(float(confidence), 3),
                                       box=[float(v) for v in box], frames=sum(hazard.history),
                                       dwell=round(seconds - hazard.first_hit, 2), repeat=hazard.alerts > 1,
                                       zone_id=zone.id if zone else None, zone_name=zone.name if zone else None,
                                       zone_pct=zone.points_pct if zone else None))
            elif hazard.active and not persistent and seconds - hazard.last_hit > self.rule.clear_seconds:
                hazard.active = False
                hazard.first_hit = None
                hazard.best = None
                events.append(dict(type='cleared', hazard=name, seconds=seconds))
        return info, events

    @property
    def active_now(self):
        return sorted(name for name, hazard in self.state.items() if hazard.active)
