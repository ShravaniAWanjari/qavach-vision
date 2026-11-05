import type { Camera } from '../data/types';

// Why a camera is not fully working. The demo has no health feed from real cameras yet, so
// each fault is a fixed, plausible reason per camera; a connected camera reports its own.
const OFFLINE = ['No signal from the camera', 'Network link down at the switch', 'Power lost at the pole', 'Stream sign-in rejected', 'Camera restarting'];
const DEGRADED = ['Low frame rate, the link is congested', 'Picture is blurred or the lens is dirty', 'Dropping frames'];

const REASONS: Record<string, string> = {
  'YRD-27': 'Network link down at the switch',
  'WSH-07': 'Power lost at the pole',
  'YRD-14': 'Low frame rate, the link is congested',
  'PER-08': 'Picture is blurred or the lens is dirty',
  'RFR-05': 'Dropping frames',
};

export function healthReason(cam: Camera): string {
  if (REASONS[cam.id]) return REASONS[cam.id];
  const list = cam.status === 'offline' ? OFFLINE : DEGRADED;
  const n = [...cam.id].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  return list[n % list.length];
}
