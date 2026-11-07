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

/** The bundled set-up with its times moved to `now`, or nothing when no file was added. */
export function demoSetup(now: number): Setup | undefined {
  const file = Object.values(files)[0];
  if (!file?.cameras?.length) return undefined;
  const by = now - file.exportedAt;
  return { ...shift(file, by), exportedAt: now };
}

/** The file to save. Stream user names are left out, and a video that was uploaded to the detection service is not
 *  carried over (the file would not exist for anyone else), so that camera shows as a plain demo camera. */
export function setupFile(s: Omit<Setup, 'exportedAt'>): Blob {
  const cameras = s.cameras.map((c): Camera => {
    if (!c.source) return c;
    const { source, ...rest } = c;
    return source.kind === 'upload' ? rest : { ...rest, source: { ...source, user: undefined } };
  });
  return new Blob([JSON.stringify({ exportedAt: Date.now(), ...s, cameras }, null, 1)], { type: 'application/json' });
}
