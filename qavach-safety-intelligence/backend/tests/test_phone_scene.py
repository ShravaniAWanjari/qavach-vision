"""Phone use by scene: the scene mode, posture, lights at the hands, and the phone rule's confirmed and possible alerts.
Made-up pictures, keypoints and tracks only (no model, no camera)."""
import numpy as np

from qavach import phonecues, scene
from qavach.intrusion import Rule, ZonePx
from qavach.moverules import PHONE_ID_OFFSET, PhoneRule

W, H = 1280, 720
FULL = ZonePx(id='z', name='Yard', points=np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.int32), points_pct=[[0, 0], [100, 0], [100, 100], [0, 100]])


def rule(**kw):
    base = dict(dwell_seconds=1.0, min_frames=2, min_confidence=0.0, repeat_seconds=0.0)
    base.update(kw)
    return Rule(**base)


def picture(bgr, h=180, w=320):
    return np.full((h, w, 3), bgr, dtype=np.uint8)


# ── scene mode ─────────────────────────────────────────────────────────────────────────────────────────────────────
def test_scene_modes():
    rng = np.random.default_rng(1)
    day = picture((90, 140, 170)) + rng.integers(0, 40, (180, 320, 3), dtype=np.uint8)
    assert scene.classify(scene.measure(day)) == 'day'
    floodlit = picture((10, 10, 15))
    floodlit[20:160, 30:290] = (40, 90, 140)                          # an orange-lit apron in a dark yard
    assert scene.classify(scene.measure(floodlit)) == 'night-lit'
    dark = picture((8, 8, 12))
    dark[10:20, 10:20] = (200, 220, 230)                              # one lamp
    assert scene.classify(scene.measure(dark)) == 'night-dark'
    infrared = picture((70, 70, 70)) + rng.integers(0, 30, (180, 320, 1), dtype=np.uint8)   # grey, same in all three channels
    assert scene.classify(scene.measure(infrared)) == 'night-ir'
    grey_day = picture((190, 190, 190))                               # overcast concrete: colourless but bright
    assert scene.classify(scene.measure(grey_day)) == 'day'


def test_scene_is_measured_on_the_first_frame_then_every_n_frames():
    watch = scene.SceneWatch(check_every=15)
    calls = []

    def look():
        calls.append(1)
        return picture((150, 150, 200))

    for _ in range(46):
        watch.update(look)
    assert len(calls) == 4                     # frames 0, 15, 30 and 45
    assert watch.mode == 'day'


def test_scene_switches_only_after_repeated_readings():
    watch = scene.SceneWatch(check_every=1, switch_after=2)
    bright, dark = picture((150, 150, 200)), picture((5, 5, 8))
    assert watch.update(bright) == 'day'
    assert watch.update(dark) == 'day'         # one dark reading (a passing shadow, an exposure swing) is not enough
    assert watch.update(bright) == 'day'
    assert watch.update(dark) == 'day'
    assert watch.update(dark) == 'night-dark'


# ── posture ────────────────────────────────────────────────────────────────────────────────────────────────────────
def pose(**points):
    """17 COCO keypoints, all unseen except those given as name=(x, y)."""
    names = dict(nose=0, l_ear=3, r_ear=4, l_sh=5, r_sh=6, l_wr=9, r_wr=10, l_hip=11, r_hip=12)
    kp = np.zeros((17, 3), dtype=np.float32)
    for name, (x, y) in points.items():
        kp[names[name]] = (x, y, 0.9)
    return kp


BODY = dict(nose=(500, 320), l_ear=(490, 318), r_ear=(510, 318), l_sh=(480, 345), r_sh=(520, 345), l_hip=(485, 410), r_hip=(515, 410))
PERSON_BOX = (470, 300, 530, 500)


def test_posture_call_texting_and_neither():
    assert phonecues.posture(pose(**BODY, l_wr=(492, 322), r_wr=(525, 400)), PERSON_BOX) == 'call'
    assert phonecues.posture(pose(**BODY, l_wr=(496, 375), r_wr=(506, 376)), PERSON_BOX) == 'texting'
    assert phonecues.posture(pose(**BODY, l_wr=(470, 420), r_wr=(530, 420)), PERSON_BOX) is None    # arms down
    assert phonecues.posture(None, PERSON_BOX) is None
    assert phonecues.posture(pose(**BODY, l_wr=(492, 322), r_wr=(508, 322)), PERSON_BOX) == 'binoculars'
    assert phonecues.posture(pose(**BODY, l_wr=(492, 322)), PERSON_BOX) is None                     # other hand hidden: can't tell
    assert phonecues.posture(pose(**BODY, l_wr=(492, 322), r_wr=(470, 330)), PERSON_BOX) == 'binoculars'


# ── lights at the hands ────────────────────────────────────────────────────────────────────────────────────────────
def night_person(light=None, size=4, value=200, strip=False):
    """A dark frame with a dim person at PERSON_BOX and, optionally, a light at the right wrist."""
    frame = np.full((H, W, 3), 6, dtype=np.uint8)
    x1, y1, x2, y2 = PERSON_BOX
    frame[y1:y2, x1:x2] = 25
    if light is not None:
        x, y = light
        frame[y - size:y + size, x - size:x + size] = value
    if strip:
        frame[380:383, x1 + 2:x2 - 2] = 230                        # a reflective strip across the vest
    return frame


KP = pose(**BODY, l_wr=(498, 378), r_wr=(504, 378))


def test_screen_light_at_the_hands():
    found = phonecues.glow(night_person(light=(502, 372)), PERSON_BOX, KP)
    assert found and found[0].kind == 'screen' and found[0].near_hands


def test_flashlight_burns_out_a_larger_area():
    found = phonecues.glow(night_person(light=(502, 372), size=8, value=255), PERSON_BOX, KP)
    assert found and found[0].kind == 'flashlight'


def test_reflective_strip_and_far_lights_are_not_phones():
    assert phonecues.glow(night_person(strip=True), PERSON_BOX, KP) == []
    assert phonecues.glow(night_person(light=(470, 495)), PERSON_BOX, KP) == []      # at the feet, far from hands and face


def test_lamp_behind_the_person_is_ignored():
    frame = night_person(light=(502, 372))
    static = phonecues.StaticLights()
    static.update(frame)                                            # the light was there with nobody in front of it
    assert phonecues.glow(frame, PERSON_BOX, KP, static) == []
    fresh = phonecues.StaticLights()
    fresh.update(frame, [PERSON_BOX])                               # it is only ever seen on the person: it is theirs
    assert phonecues.glow(frame, PERSON_BOX, KP, fresh)


# ── the phone rule by scene ────────────────────────────────────────────────────────────────────────────────────────
P = (1, *PERSON_BOX, 0.9)


def drive(engine, scene_mode, cues, phone=None, frames=15, fps=5):
    alerts = []
    for k in range(frames):
        engine.scene, engine.cues = scene_mode, {1: cues}
        tracks = [P] + ([phone] if phone else [])
        alerts += [e for e in engine.update(k / fps, tracks)[1] if e['type'] == 'alert']
    return alerts


SCREEN = phonecues.Light('screen', 0.8, (498, 368, 506, 376), True, True)
TORCH = phonecues.Light('flashlight', 0.7, (494, 364, 510, 380), True, False)


def test_day_phone_object_is_confirmed():
    alerts = drive(PhoneRule([FULL], rule()), 'day', (None, []), phone=(PHONE_ID_OFFSET, 495, 370, 505, 385, 0.6))
    assert alerts and alerts[0]['level'] == 'confirmed' and alerts[0]['cue'] == 'phone' and alerts[0]['scene'] == 'day'


def test_weak_phone_object_needs_a_posture():
    weak = (PHONE_ID_OFFSET, 495, 370, 505, 385, 0.3)
    assert drive(PhoneRule([FULL], rule()), 'day', (None, []), phone=weak) == []
    alerts = drive(PhoneRule([FULL], rule()), 'day', ('texting', []), phone=weak)
    assert alerts and alerts[0]['level'] == 'confirmed' and 'texting' in alerts[0]['cue']


def test_screen_light_at_night_is_confirmed_but_not_by_day():
    alerts = drive(PhoneRule([FULL], rule()), 'night-dark', (None, [SCREEN]))
    assert alerts and alerts[0]['level'] == 'confirmed' and alerts[0]['cue'] == 'screen light'
    assert drive(PhoneRule([FULL], rule()), 'day', (None, [SCREEN])) == []


def test_flashlight_and_hand_at_ear_are_possible_only():
    torch = drive(PhoneRule([FULL], rule()), 'night-lit', (None, [TORCH]))
    assert torch and torch[0]['level'] == 'possible' and torch[0]['cue'] == 'flashlight'
    ear = drive(PhoneRule([FULL], rule()), 'day', ('call', []))
    assert ear and ear[0]['level'] == 'possible' and ear[0]['cue'] == 'hand at ear'
    assert drive(PhoneRule([FULL], rule()), 'day', ('texting', [])) == []        # hands together alone: a clipboard too


def test_screen_on_an_infrared_camera_is_possible():
    alerts = drive(PhoneRule([FULL], rule()), 'night-ir', (None, [SCREEN]))
    assert alerts and alerts[0]['level'] == 'possible'


def test_a_sure_sign_upgrades_a_possible_spell():
    engine = PhoneRule([FULL], rule(dwell_seconds=2.0))
    alerts = drive(engine, 'night-lit', (None, [TORCH]), frames=5)
    alerts += drive(engine, 'night-lit', (None, [TORCH, SCREEN]), frames=15)
    assert alerts and alerts[0]['level'] == 'confirmed'


def test_hold_stretches_with_slow_frames():
    """At 0.5 analysed frames a second a sign seen every other frame still holds."""
    engine = PhoneRule([FULL], rule(dwell_seconds=4.0, min_frames=2))
    alerts = []
    for k in range(8):
        engine.scene, engine.cues = 'night-dark', {1: (None, [SCREEN] if k % 2 == 0 else [])}
        alerts += [e for e in engine.update(k * 2.0, [P])[1] if e['type'] == 'alert']
    assert alerts


def test_skin_and_lit_window_are_not_screens():
    skin = night_person()
    skin[368:376, 498:506] = (120, 160, 215)                      # a hand lit by a lamp: warm, red well above blue
    assert phonecues.glow(skin, PERSON_BOX, KP) == []
    window = night_person()
    window[300:420, 480:520] = (200, 200, 200)                    # a lit window pane behind the person, wider than a screen
    window[368:376, 498:506] = 230
    assert phonecues.glow(window, PERSON_BOX, KP) == []


def test_flickering_hand_at_ear_does_not_alert():
    engine = PhoneRule([FULL], rule(dwell_seconds=1.0, min_frames=2))
    alerts = []
    for k in range(15):
        engine.scene, engine.cues = 'day', {1: ('call' if k % 3 == 0 else None, [])}
        alerts += [e for e in engine.update(k / 5, [P])[1] if e['type'] == 'alert']
    assert alerts == []


def test_one_frame_phone_is_not_carried_at_a_slow_frame_rate():
    """At one analysed frame every 2 s, a single frame where binoculars score as a phone must not alert."""
    engine = PhoneRule([FULL], rule(dwell_seconds=2.0, min_frames=2))
    alerts = []
    for k in range(6):
        phone = [(PHONE_ID_OFFSET, 495, 320, 505, 330, 0.5)] if k == 1 else []
        engine.scene, engine.cues = 'day', {1: (None, [])}
        alerts += [e for e in engine.update(k * 2.0, [P] + phone)[1] if e['type'] == 'alert']
    assert alerts == []


def test_binoculars_posture_overrules_a_phone_object():
    at_face = (PHONE_ID_OFFSET, 495, 315, 505, 325, 0.45)
    assert drive(PhoneRule([FULL], rule()), 'day', ('binoculars', []), phone=at_face) == []
    sure = (PHONE_ID_OFFSET, 495, 315, 505, 325, 0.8)
    assert drive(PhoneRule([FULL], rule()), 'day', ('binoculars', []), phone=sure) == []
    assert drive(PhoneRule([FULL], rule()), 'night-dark', ('binoculars', [SCREEN]))           # a lit screen still counts


def test_phone_object_must_be_in_a_hand_when_wrists_are_seen():
    at_chest = (PHONE_ID_OFFSET, 495, 350, 505, 362, 0.6)          # binoculars hanging on the chest
    hands_down = ([(475, 440), (525, 440)], 40.0)                  # writing on a chart, well below
    assert drive(PhoneRule([FULL], rule()), 'day', (None, [], *hands_down), phone=at_chest) == []
    in_hand = ([(500, 362), (525, 440)], 40.0)
    assert drive(PhoneRule([FULL], rule()), 'day', (None, [], *in_hand), phone=at_chest)


def test_binoculars_posture_is_remembered_for_a_few_seconds():
    engine = PhoneRule([FULL], rule(dwell_seconds=1.0))
    at_face = (PHONE_ID_OFFSET, 495, 315, 505, 325, 0.7)
    alerts = drive(engine, 'day', ('binoculars', []), phone=at_face, frames=5)        # 1 s with the binoculars posture
    alerts += [e for k in range(5, 15) for e in (lambda: (setattr(engine, 'scene', 'day'), setattr(engine, 'cues', {1: (None, [])}),
               engine.update(k / 5, [P, at_face])[1])[2])()]                          # pose misses it for 2 s more
    assert alerts == []
