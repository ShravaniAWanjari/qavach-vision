import { SAMPLE_VIDEOS } from '../data/samples';
import type { Alert, Camera, Policy, Rule, Wall } from '../data/types';

// A saved set-up: the cameras, rules, walls, alerts and alert levels as one JSON file. Someone sets the console up the
// way they want to show it, saves it from the Cameras page, and puts the file at src/data/demo-state.json. Everyone who
// opens the site for the first time then starts from it. A browser that already has its own saved data keeps that.

export interface Setup {
  exportedAt: number;
  cameras: Camera[];
  rules: Rule[];
  walls: Wall[];
  alerts: Alert[];
  policies: Policy[];
}

/** Times in the file are real dates from when it was saved; moved so the newest alert looks as recent as it did then. */
const isTime = (n: number) => n > 1e12 && n < 4e12;
const shift = <T,>(v: T, by: number): T => {
  if (typeof v === 'number') return (isTime(v) ? v + by : v) as T;
  if (Array.isArray(v)) return v.map((x) => shift(x, by)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x, by)])) as T;
  return v;
};

const files = import.meta.glob<Setup>('../data/demo-state.json', { eager: true, import: 'default' });

/** How long ago, in minutes, each open alert looks when the site is opened: newest first. The open alerts are re-timed one by
 *  one (every time on an alert moves with it) so the Action Centre looks like a live shift, not like alerts left for a day. */
const OPEN_AGES_MIN = [0.3, 1, 3, 9, 11, 24, 38];
const isOpenAlert = (a: Alert) => a.state === 'new' || a.state === 'escalated';

/** The bundled set-up with its times moved to `now`: history keeps the age it had when it was saved, and the open alerts are
 *  fresh. Nothing is added or removed. */
export function demoSetup(now: number): Setup | undefined {
  const file = Object.values(files)[0];
  if (!file?.cameras?.length) return undefined;
  const by = now - file.exportedAt;
  const moved = shift(file, by);
  const open = moved.alerts.filter(isOpenAlert).sort((a, b) => b.at - a.at);
  const retimed = new Map<string, Alert>();
  open.forEach((a, i) => {
    const minutes = OPEN_AGES_MIN[i] ?? OPEN_AGES_MIN[OPEN_AGES_MIN.length - 1] + (i - OPEN_AGES_MIN.length + 1) * 7;
    retimed.set(a.id, shift(a, now - minutes * 60000 - a.at));
  });
  return { ...moved, alerts: moved.alerts.map((a) => retimed.get(a.id) ?? a), exportedAt: now };
}

/** The file to save. Stream user names and passwords are left out. A camera on one of the sample videos that ship with the
 *  service keeps it (everyone has that file, found by its id); a camera on a video someone uploaded does not (the file would
 *  not exist for anyone else), so it shows as a plain demo camera. A saved still picture is dropped: the service shows
 *  the camera's latest frame instead. */
export function setupFile(s: Omit<Setup, 'exportedAt'>): Blob {
  const bundled = new Set<string>(SAMPLE_VIDEOS.map((v) => v.id));
  const cameras = s.cameras.map((c): Camera => {
    if (!c.source) return c;
    const { source, ...rest } = c;
    if (source.kind === 'upload') {
      if (!bundled.has(source.uploadId ?? '')) return rest;
      const { frameUrl: _frame, user: _user, ...kept } = source;
      return { ...rest, source: kept };
    }
    const { frameUrl: _frame, user: _user, ...kept } = source;
    return { ...rest, source: kept };
  });
  return new Blob([JSON.stringify({ exportedAt: Date.now(), ...s, cameras }, null, 1)], { type: 'application/json' });
}
