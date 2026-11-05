import type { CSSProperties } from 'react';
import type { Camera, SceneKind } from '../data/types';

// Demo only: real port CCTV pictures in place of the drawn sample scenes, so the camera list and the video
// wall look like a real site. Switch DEMO_PHOTOS off to get the drawn scenes back. Cameras connected to the
// detection service (cam.source) and alerts (which draw their subject on the scene) are never touched.
export const DEMO_PHOTOS = true;

const POOL: Record<SceneKind, string[]> = {
  quay: ['quay-pier', 'quay-sunset', 'quay-fog', 'deck-barge1'],
  deck: ['deck-barge1', 'deck-barge2'],
  yard: ['yard-day1', 'yard-day2', 'lot-day', 'yard-night1', 'yard-night2'],
  reefer: ['lot-day', 'yard-day2', 'yard-night2'],
  gate: ['gate-road', 'gate-road-night', 'gate-road'],
  workshop: ['shed-left', 'shed-left-night'],
  hazmat: ['shed-left-night', 'yard-night1', 'gate-road-night'],
  perimeter: ['yard-rain', 'yard-day1', 'gate-road', 'yard-night2'],
};

// Cameras of one area share a few pictures, so each camera shows its own part of the picture:
// mirrored on odd cameras, and zoomed into the bottom left or right on every second and third.
const ZOOM = 1.45;
const ZOOM_LEFT: (string | undefined)[] = [undefined, '0%', `${-(ZOOM - 1) * 100}%`];

export function demoPhoto(cam: Camera): { src: string; style: CSSProperties } | undefined {
  if (!DEMO_PHOTOS || cam.source || cam.status === 'offline') return undefined;
  const pool = POOL[cam.scene];
  if (!pool) return undefined;
  const n = cam.variant;
  const left = ZOOM_LEFT[n % ZOOM_LEFT.length];
  const style: CSSProperties = {
    transform: n % 2 ? 'scaleX(-1)' : undefined,
    filter: cam.status === 'degraded' ? 'brightness(.62) saturate(.6) contrast(1.1)' : undefined,
  };
  if (left !== undefined) Object.assign(style, { inset: 'auto', width: `${ZOOM * 100}%`, height: `${ZOOM * 100}%`, left, top: `${-(ZOOM - 1) * 100}%` });
  return { src: `/cams/${pool[n % pool.length]}.jpg`, style };
}
