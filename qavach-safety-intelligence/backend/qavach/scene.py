"""What kind of scene a camera is looking at, so the phone rule knows which cue it can see.

    day         good light, colour picture: a phone shows as a dark object in the hand
    night-lit   dark but floodlit, colour picture: the phone object or the light of its screen
    night-dark  very dark: only the light of a screen (or a phone torch) shows
    night-ir    the camera is in infrared night mode (black-and-white picture): a screen gives off little infrared, so its glow
                may not show; posture and the phone object are all there is, and results are only "possible"

The scene changes slowly (dusk, floodlights coming on), so it is measured on the first frame and then every CHECK_EVERY analysed
frames, not on every frame. A new mode must be read SWITCH_AFTER times in a row before it is used, so passing headlights or a
camera's auto-exposure swing do not flip it. Measuring is cheap: the region is shrunk to at most 160 pixels wide first.
"""
import cv2
import numpy as np

CHECK_EVERY = 15             # analysed frames between two measurements (the first frame is always measured)
SWITCH_AFTER = 2             # readings of a new mode in a row before it replaces the current one
SAMPLE_WIDTH = 160           # the region is shrunk to this width before measuring

DAY_BRIGHTNESS = 85          # mean brightness (0-255) at or above which a colour picture can be day ...
DAY_DARK_SHARE = 0.25        # ... when also fewer than this share of its pixels are dark: a floodlit night is often as bright
                             #     on average, but keeps its black sky and deep shadows
DAY_BRIGHT_QUARTER = 105     # ... and the brightest quarter of the picture is at least this bright: daylight lights sky and
                             #     concrete well; a night lit by fires or lamps is bright only in patches (measured: night
                             #     harbour clips 96-99, overcast day clips 119-120)
DARK_PIXEL = 40              # a pixel darker than this counts as dark
DARK_SHARE = 0.65            # night-dark when at least this share of pixels is dark; otherwise night-lit
IR_SATURATION = 10           # mean colour saturation (0-255) below which the picture has no colour ...
IR_CHANNEL_GAP = 4           # ... and its blue, green and red channels are this close: an infrared night picture
IR_BRIGHTNESS = 150          # a colourless but this bright picture is a grey day (fog, overcast concrete), not infrared

MODES = ('day', 'night-lit', 'night-dark', 'night-ir')


def measure(image):
    """Brightness, colour and darkness of a BGR picture: dict(brightness, bright_quarter, saturation, channel_gap, dark_share)."""
    height, width = image.shape[:2]
    if width > SAMPLE_WIDTH:
        image = cv2.resize(image, (SAMPLE_WIDTH, max(1, round(height * SAMPLE_WIDTH / width))), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    value = hsv[..., 2].astype(np.float32)
    small = image.astype(np.int16)
    gap = (np.abs(small[..., 0] - small[..., 1]) + np.abs(small[..., 1] - small[..., 2])).mean() / 2
    return dict(brightness=float(value.mean()), bright_quarter=float(np.percentile(value, 75)), saturation=float(hsv[..., 1].mean()), channel_gap=float(gap),
                dark_share=float((value < DARK_PIXEL).mean()))


def classify(m):
    """The scene mode for one measurement."""
    colourless = m['saturation'] < IR_SATURATION and m['channel_gap'] < IR_CHANNEL_GAP
    if colourless and m['brightness'] < IR_BRIGHTNESS:
        return 'night-ir'
    if m['brightness'] >= DAY_BRIGHTNESS and m['dark_share'] < DAY_DARK_SHARE and m['bright_quarter'] >= DAY_BRIGHT_QUARTER:
        return 'day'
    return 'night-dark' if m['dark_share'] >= DARK_SHARE else 'night-lit'


class SceneWatch:
    """The scene mode of one area of one camera, measured every CHECK_EVERY frames with hysteresis."""

    def __init__(self, check_every=CHECK_EVERY, switch_after=SWITCH_AFTER):
        self.check_every, self.switch_after = check_every, switch_after
        self.mode, self.reading, self.frames, self._candidate, self._votes = None, None, 0, None, 0
        self.checks = 0

    def due(self):
        """True when this frame should be measured: the first frame, then every `check_every` frames."""
        return self.mode is None or self.frames % self.check_every == 0

    def update(self, image):
        """Count one analysed frame, measuring `image` (a BGR picture, or a function returning one) when due. Returns the mode."""
        if self.due():
            picture = image() if callable(image) else image
            if picture is not None and picture.size:
                self.reading = measure(picture)
                self.checks += 1
                self._vote(classify(self.reading))
        self.frames += 1
        return self.mode

    def _vote(self, mode):
        if self.mode is None:                 # the first reading is used at once: no mode is worse than a possibly wrong one
            self.mode, self._candidate, self._votes = mode, None, 0
        elif mode == self.mode:
            self._candidate, self._votes = None, 0
        elif mode == self._candidate:
            self._votes += 1
            if self._votes >= self.switch_after:
                self.mode, self._candidate, self._votes = mode, None, 0
        else:
            self._candidate, self._votes = mode, 1
            if self._votes >= self.switch_after:
                self.mode, self._candidate, self._votes = mode, None, 0
