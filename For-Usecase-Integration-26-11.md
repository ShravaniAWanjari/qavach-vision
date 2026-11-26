# For use-case integration (26-11)

Four use cases, their default rules, the code behind them, and the sample videos they run on.
All paths are relative to this repo root. App: `qavach-safety-intelligence/`. Detection service: `qavach-safety-intelligence/backend/`.

Shared code:
- **Default cameras and rules:** `backend/seed/state.json` for the service and `src/data/demo-state.json` for the console.
- **Rule settings and checks:** `backend/qavach/zonerules.py`.
- **Per-camera pipeline:** `backend/qavach/camera_runner.py`.
- **Detector:** `backend/qavach/detector.py`, using YOLO11s.
- **Sample video list:** `src/data/samples.ts`.

## 1. Phone usage

| | |
|---|---|
| Rule | **R-18 Phone use at the guard post**, condition `phone`, P3, live. It alerts after the phone is seen for 2 s (in at least 2 frames). It repeats at most every 10 s. Minimum confidence is 0.3. |
| Camera | GTE-52 · Gate · guard post, zone `GTE-52-Z-1` |
| Files | `backend/qavach/moverules.py` (`PhoneRule`), `backend/qavach/zoom.py` (zoom pass), `backend/qavach/phonecues.py` (call/texting posture, screen light at night), `backend/qavach/scene.py` (day/night) |
| Video | Phone Usage Sample. File `backend/samples/5a3b1e00000a.mp4`, original name `gate-guard-post.mp4`. |

**Will it work for a given camera view (overlap test)?**
- **Overlap test:** a phone counts only if its box overlaps the person's box, allowing 15% extra around it (`PHONE_PAD`).
- **Wrist check:** when the pose model can see the wrists, the phone must also be within 0.7 shoulder widths of a wrist (`PHONE_WRIST_REACH`).
- **Zoom pass for small people:** anyone shorter than 55% of the picture height is cropped and enlarged up to 4×, then searched again for phones. This applies to the 4 largest such people per frame.
- **Feasible:** the camera sees people from the front or side with their hands visible, at gate or guard-post distance.
- **Not feasible:**
  - the camera looks at people's backs;
  - the hands are hidden by a desk or the body;
  - people are only a few pixels tall, which is too small even after zooming.
- **Test:** test a new camera view by running R-18 in `test` mode on a recorded clip first.

## 2. People counting / crowd density

| | |
|---|---|
| Rule | **R-16 People Count Limit Exceeded**, condition `crowd`, `crowdOver` 6. It alerts when more than 6 people are in the zone for 5 s (in at least 2 frames). Minimum confidence is 0.3. It repeats at most every 10 s. P3. |
| Camera | QUA-133 · Berth 2 · night apron, zone `QUA-133-Z-1` |
| Files | `backend/qavach/zonerules.py` (`CrowdRule`), `backend/qavach/crowdcount.py` (counts on the whole picture plus 2×2 tiles, so small or far people are counted) |
| Video | Crowd Limit Exceeded Sample. File `backend/samples/5a3b1e000009.mp4`, original name `berth-2-night-apron.mp4`. |

## 3. Grouping (people gathered in an area)

| | |
|---|---|
| Rule | **R-17 Large Crowd Gathering**, condition `gathering`, `minPeople` 8, `gatherReach` 1.0. It alerts when at least 8 people stand together for 2 s (in at least 2 frames). Minimum confidence is 0.3. It repeats at most every 10 s. P3. |
| Camera | GTE-51 · Gate · pedestrian crossing, zone `GTE-51-Z-1` |
| Files | `backend/qavach/zonerules.py` (`GatheringRule` and `biggest_group`). People belong to the same group when their foot points are within `gatherReach` person heights of each other. The tile counting in `crowdcount.py` is shared with use case 2. |
| Video | Large Crowd Gathering Sample. File `backend/samples/5a3b1e000008.mp4`, original name `gate-pedestrian-crossing.mp4`. |

## 4. Vehicle dwell time

| | |
|---|---|
| Rule | **R-20 Vehicle Dwell Time Exceeded**, subject `vehicle`, condition `dwells`, 30 s. It alerts when a vehicle stays in the zone for 30 s (in at least 3 frames). Minimum confidence is 0.3. It repeats at most every 60 s. P3. |
| Camera | GTE-53 · Berth 3 · vehicle marshalling lane, zone `GTE-53-Z-1` |
| Files | `backend/qavach/intrusion.py` (`IntrusionRule`, which handles dwell), `backend/qavach/zonerules.py` (settings and the engine for each rule), `backend/qavach/detector.py` (vehicle classes) |
| Video | Intrusion Detection Sample. File `backend/samples/5a3b1e000007.mp4`, original name `berth-3-access-gate.mp4`. The same video is used by R-14 Restricted Area Activity and R-21 Pedestrian Vehicle Proximity. |

## Sample videos

- **Location:** stored in `qavach-safety-intelligence/backend/samples/` as `<id>.mp4`.
- **Listing:** the id, label and original file name of each are in `src/data/samples.ts`.
- **Fallback frames:** shown when the detection service is not running, from `public/fallback/<id>/1.jpg` to `6.jpg`.
- **Defaults:** set in `backend/seed/state.json` (`cameras[].source.uploadId`). They are applied once for each new version of that file. To reset browsers to them, change `SEED_VERSION` in `src/lib/persist.ts`.
