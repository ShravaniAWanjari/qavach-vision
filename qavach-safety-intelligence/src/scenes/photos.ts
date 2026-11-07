import type { CSSProperties } from 'react';
import type { Camera, SceneKind } from '../data/types';
import { assetUrl } from '../lib/assets';

// Demo only: real port CCTV pictures in place of the drawn sample scenes everywhere, alert snapshots included, so
// the console looks like a real site. Offline cameras keep the drawn scene with its no-signal look. Switch
// DEMO_PHOTOS off to get the drawn scenes back. Cameras connected to the detection service (cam.source) are never touched.
export const DEMO_PHOTOS = true;

// Each camera gets pictures that fit its name: a lashing cage never shows open water, a gate lane never shows a ship.
// Pictures with a burnt-in "CAM" label, timecode or a cruise ship are left out. Nothing is mirrored, since mirrored signs read wrong.
const AREA_POOL: Record<SceneKind, string[]> = {
  quay: ['quay-cranes', 'quay-terminal', 'quay-pier', 'quay-aerial', 'quay-colon', 'quay-sunset', 'quay-night', 'quay-bluecrane', 'quay-night2'],
  deck: ['deck-barge1', 'deck-barge2', 'deck-hull', 'deck-collision', 'deck-support'],
  yard: ['yard-day1', 'yard-stacker', 'yard-aerial', 'yard-day2', 'yard-night1', 'yard-night2'],
  reefer: ['reefer-aerial', 'yard-stacker', 'yard-day2', 'yard-night2'],
  gate: ['gate-road', 'gate-road-night', 'lot-day'],
  workshop: ['shed-left', 'shed-left-night'],
  hazmat: ['yard-stacker', 'yard-day1', 'yard-night1'],
  perimeter: ['yard-rain', 'yard-day1', 'gate-road', 'yard-night2'],
};
// More specific names first. The first match wins.
const NAME_POOL: [RegExp, string[]][] = [
  [/lashing/i, ['quay-terminal', 'quay-cranes']],
  [/waterside/i, ['quay-colon', 'quay-pier', 'quay-sunset']],
  [/landside/i, ['quay-cranes', 'quay-terminal', 'quay-bluecrane']],
  [/gangway/i, ['deck-barge1', 'deck-barge2', 'deck-support']],
  [/holding area|walkway/i, ['lot-day', 'gate-road']],
  [/spill kit|enclosure|class \d|imdg/i, ['yard-stacker', 'yard-day1']],
  [/fence|rail siding/i, ['yard-rain', 'yard-day1', 'yard-night2']],
  [/gantry/i, ['reefer-aerial', 'yard-stacker']],
];

const poolFor = (cam: Camera) => NAME_POOL.find(([re]) => re.test(cam.name))?.[1] ?? AREA_POOL[cam.scene];

// Cameras of one area share a few pictures, so each camera shows its own part of the picture: the whole frame, or a
// zoom into the bottom left, bottom right or top of it.
const ZOOM = 1.45;
const CROPS: ({ left: string; top: string } | undefined)[] = [
  undefined,
  { left: '0%', top: `${-(ZOOM - 1) * 100}%` },
  { left: `${-(ZOOM - 1) * 100}%`, top: `${-(ZOOM - 1) * 100}%` },
  { left: `${-(ZOOM - 1) * 50}%`, top: '0%' },
];

export function demoPhoto(cam: Camera): { src: string; style: CSSProperties } | undefined {
  if (!DEMO_PHOTOS || cam.source || cam.status === 'offline') return undefined;
  const pool = poolFor(cam);
  if (!pool) return undefined;
  const n = cam.variant;
  // Same picture only every pool-length cameras; the crop changes on each lap, so neighbours rarely look alike.
  const crop = CROPS[Math.floor(n / pool.length) % CROPS.length];
  const style: CSSProperties = {
    filter: cam.status === 'degraded' ? 'brightness(.62) saturate(.6) contrast(1.1)' : undefined,
  };
  if (crop) Object.assign(style, { inset: 'auto', width: `${ZOOM * 100}%`, height: `${ZOOM * 100}%`, left: crop.left, top: crop.top });
  return { src: assetUrl(`cams/${pool[n % pool.length]}.jpg`), style };
}
