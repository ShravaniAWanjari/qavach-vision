import type { Camera, Rule } from '../data/types';
import { assetUrl } from './assets';

// Client for the detection service in ../backend. The console works without it, on sample data; with it, cameras can
// be real (a YouTube live link, a stream address or an uploaded video) and rules run on them.

/** Opened from disk (the single-file build) there is no dev server to proxy /api, so call the service directly. Anywhere else
 *  the service is at "api/..." beside the console, which also works when the console is served from a sub-path. */
const FROM_DISK = typeof window !== 'undefined' && window.location.protocol === 'file:';
export const apiUrl = (path: string) => (path.startsWith('http') ? path : FROM_DISK ? `http://127.0.0.1:8830${path}` : assetUrl(path));

export class BackendError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch {
    throw new BackendError('The detection service is not running. Start it with backend/run.sh.');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).detail ?? msg;
    } catch {
      /* not JSON */
    }
    throw new BackendError(msg);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface ProbeResult {
  frameId: string;
  frameUrl: string;
  kind: 'youtube' | 'stream' | 'upload';
  width: number;
  height: number;
  fps: number | null;
  live: boolean;
  seconds: number | null;
  title: string;
}
export interface UploadResult extends ProbeResult {
  uploadId: string;
  name: string;
  bytes: number;
}

export interface BackendEvent {
  seq: number;
  id: string;
  at: number;
  cameraId: string;
  ruleId: string;
  zoneId: string | null;
  zoneName: string;
  trackId: number;
  /** Set for fire and smoke alerts: which one was seen. */
  hazard?: 'fire' | 'smoke';
  confidence: number;
  dwell: number;
  frames: number;
  moved: number;
  reentry: boolean;
  mode: 'live' | 'test';
  box: [number, number, number, number];
  snapshot: string;
}
export interface CameraStatus {
  state: 'starting' | 'running' | 'reconnecting' | 'error' | 'stopped';
  error: string | null;
  rules: number;
  fps: number;
  source_fps: number;
  people: number;
  detecting: boolean;
  alerts: number;
}
export interface PollResult {
  epoch: string;
  next: number;
  events: BackendEvent[];
  cameras: Record<string, CameraStatus>;
}

export interface Credentials {
  user: string;
  password: string;
}

/** Stream passwords, in memory only: typed in the camera editor, sent to the service, never saved by the console.
 *  The service keeps its own copy for as long as it runs. */
const passwords = new Map<string, string>();
export const rememberPassword = (cameraId: string, password: string) => {
  if (password) passwords.set(cameraId, password);
};

function cameraBody(cam: Camera) {
  const s = cam.source!;
  const password = passwords.get(cam.id);
  return {
    name: cam.name,
    zones: cam.zones,
    source: s.kind === 'upload' ? { kind: 'upload', uploadId: s.uploadId } : { kind: 'link', url: s.url, user: s.user ?? '', ...(password ? { password } : {}) },
  };
}

/** Rules the service can use. The page keeps every field; the service picks the ones it runs. */
const ruleBody = (r: Rule) => ({ ...r });

export const backend = {
  health: () => request<{ ok: boolean; epoch: string }>('/api/health'),
  probeLink: (url: string, creds?: Credentials) => request<ProbeResult>('/api/sources/probe', json('POST', { source: { kind: 'link', url, ...(creds ?? {}) } })),
  /** Opens a video the service already holds (a bundled sample) and reads one frame from it. */
  probeUpload: (uploadId: string) => request<ProbeResult>('/api/sources/probe', json('POST', { source: { kind: 'upload', uploadId } })),
  upload(file: File, onProgress: (share: number) => void): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', apiUrl(`/api/uploads?name=${encodeURIComponent(file.name)}`));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 200) return resolve(JSON.parse(xhr.responseText));
        let msg = xhr.statusText;
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {
          /* not JSON */
        }
        reject(new BackendError(msg));
      };
      xhr.onerror = () => reject(new BackendError('The detection service is not running. Start it with backend/run.sh.'));
      xhr.send(file);
    });
  },
  putCamera: (cam: Camera) => request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(cam.id)}`, json('PUT', cameraBody(cam))),
  deleteCamera: (id: string) => request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  putRule: (rule: Rule) => request<{ ok: boolean }>(`/api/rules/${encodeURIComponent(rule.id)}`, json('PUT', ruleBody(rule))),
  deleteRule: (id: string) => request<{ ok: boolean }>(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // A built console makes the service match it exactly. The dev server's console (npm run dev) only adds and updates, so a
  // developer opening it can never wipe what a real console set up.
  sync: (cameras: Camera[], rules: Rule[]) =>
    request<{ ok: boolean; problems: string[] }>('/api/sync', json('POST', { replace: !import.meta.env.DEV, cameras: cameras.filter((c) => c.source).map((c) => ({ id: c.id, ...cameraBody(c) })), rules: rules.map(ruleBody) })),
  poll: (since: number) => request<PollResult>(`/api/events?since=${since}`),
};

/** Set by the bridge while the service answers; store actions only push changes when it is up. */
let online = false;
export const setOnline = (v: boolean) => {
  online = v;
};
export const isOnline = () => online;

/** Picture addresses for a real camera. */
export const streamUrl = (cam: Camera) => apiUrl(`/api/cameras/${encodeURIComponent(cam.id)}/stream.mjpg`);
export const stillUrl = (cam: Camera) => (cam.source?.frameUrl ? apiUrl(cam.source.frameUrl) : undefined);
