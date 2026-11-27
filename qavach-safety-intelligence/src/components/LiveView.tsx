import { useEffect, useRef } from 'react';
import type { Camera } from '../data/types';
import { apiUrl, streamUrl } from '../lib/backend';

// The live picture of a camera on the detection service, with the boxes drawn here in the browser. The service sends the
// boxes as data (positions as fractions of the picture), so it never draws on pictures, and it makes the live picture only
// while one of these is open:
//  · LiveStream reads the service's picture stream; each picture carries its own boxes, so they always match.
//  · DirectVideo plays the camera's video itself (an uploaded video, or a browser-playable address from a media server) and
//    takes only the boxes from the service: the service then makes no picture at all for this view.

type Box = [number, number, number, number, 'flagged' | 'waiting' | 'inside' | 'seen', string];
type Fire = [number, number, number, number, 'fire' | 'smoke' | 'ignored', string];
type Note = [number, number, string, 'alert' | 'warn'];
export interface Overlay {
  seq?: number;
  /** Seconds into the video (a file) or stream time (a live camera). */
  t: number;
  w: number;
  h: number;
  boxes: Box[];
  fires: Fire[];
  notes: Note[];
}

/** The box colours, from the page's colour tokens. */
function palette(el: Element) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    flagged: v('--c-red'),
    inside: v('--c-orange'),
    waiting: v('--c-blue'),
    seen: v('--c-light'),
    fire: v('--c-red'),
    smoke: v('--c-orange'),
    ignored: v('--c-grey'),
    alert: v('--c-red'),
    warn: v('--c-orange'),
    outline: v('--c-black'),
  };
}
type Palette = ReturnType<typeof palette>;

/** Draws one overlay onto a canvas the size of the picture. Line widths and text follow the picture's size, as they did when
 *  the service drew them onto its 960-pixel preview. */
export function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay, pal: Palette) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const k = Math.max(1, W / 960);
  ctx.lineJoin = 'round';
  const label = (text: string, x: number, y: number, colour: string) => {
    ctx.font = `600 ${Math.round(12 * k)}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const th = 12 * k;
    const lx = Math.max(3, Math.min(x, W - tw - 4));
    const ly = Math.max(th + 3, Math.min(y - 5 * k >= th + 3 ? y - 5 * k : y + th + 6 * k, H - 4));
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = pal.outline;
    ctx.strokeText(text, lx, ly);
    ctx.fillStyle = colour;
    ctx.fillText(text, lx, ly);
  };
  for (const [x1, y1, x2, y2, state, text] of o.boxes) {
    const c = pal[state];
    ctx.lineWidth = (state === 'flagged' ? 2 : 1) * k;
    ctx.strokeStyle = c;
    ctx.strokeRect(x1 * W - 2 * k, y1 * H - 2 * k, (x2 - x1) * W + 4 * k, (y2 - y1) * H + 4 * k);
    if (text) label(text, x1 * W - 2 * k, y1 * H - 2 * k, c);
  }
  for (const [x1, y1, x2, y2, kind, text] of o.fires) {
    const c = pal[kind];
    ctx.lineWidth = (kind === 'ignored' ? 1 : 2) * k;
    ctx.strokeStyle = c;
    ctx.strokeRect(x1 * W, y1 * H, (x2 - x1) * W, (y2 - y1) * H);
    if (text) label(text, x1 * W, y1 * H, c);
  }
  for (const [x, y, text, level] of o.notes) label(text, x * W + 6 * k, y * H - 4 * k, pal[level]);
}

const HEAD_END = [13, 10, 13, 10];
function indexOfHeadEnd(buf: Uint8Array) {
  outer: for (let i = 0; i + 3 < buf.length; i++) {
    for (let j = 0; j < 4; j++) if (buf[i + j] !== HEAD_END[j]) continue outer;
    return i;
  }
  return -1;
}

/** The service's live picture stream, read part by part, each picture drawn with the boxes that came with it. A picture
 *  still being decoded when the next arrives is simply replaced, so a slow screen never falls behind the camera. */
export function LiveStream({ cam, onBroken }: { cam: Camera; onBroken: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const broken = useRef(onBroken);
  broken.current = onBroken;
  useEffect(() => {
    const ctrl = new AbortController();
    const text = new TextDecoder();
    let latest: { jpeg: Uint8Array; overlay: Overlay | null } | null = null;
    let drawing = false;
    let pal: Palette | null = null;
    const draw = async () => {
      drawing = true;
      while (latest && !ctrl.signal.aborted) {
        const { jpeg, overlay } = latest;
        latest = null;
        try {
          const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
          const el = canvas.current;
          if (el) {
            if (el.width !== bmp.width || el.height !== bmp.height) {
              el.width = bmp.width;
              el.height = bmp.height;
            }
            const ctx = el.getContext('2d')!;
            ctx.drawImage(bmp, 0, 0);
            if (overlay) drawOverlay(ctx, overlay, (pal ??= palette(el)));
          }
          bmp.close();
        } catch {
          /* a damaged picture: wait for the next */
        }
      }
      drawing = false;
    };
    (async () => {
      const res = await fetch(streamUrl(cam), { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        for (;;) {
          const end = indexOfHeadEnd(buf);
          if (end < 0) break;
          const head = text.decode(buf.subarray(0, end));
          const size = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN);
          const start = end + 4;
          if (!Number.isFinite(size)) {
            buf = buf.subarray(start);
            continue;
          }
          if (buf.length < start + size) break;
          const raw = /x-overlay:\s*([^\r\n]*)/i.exec(head)?.[1];
          let overlay: Overlay | null = null;
          try {
            overlay = raw ? (JSON.parse(raw) as Overlay | null) : null;
          } catch {
            overlay = null;
          }
          latest = { jpeg: buf.slice(start, start + size), overlay };
          buf = buf.slice(start + size);
          if (!drawing) void draw();
        }
      }
    })().catch(() => {
      if (!ctrl.signal.aborted) broken.current();
    });
    return () => ctrl.abort();
  }, [cam.id]);
  return <canvas ref={canvas} className="camview__img" />;
}

/** How far behind the newest boxes the video plays, so the boxes for each moment have arrived before it is shown. */
const LAG = 0.5;
/** Boxes older than this (in video seconds) are not shown: the camera went quiet, or the boxes stopped coming. */
const STALE = 1.0;

/** Plays the camera's video in the browser and draws the service's boxes over it. For a video file the boxes carry their
 *  time in the video, and the video is kept in step with the service (nudging its speed; a jump only when far off). For a
 *  live address the newest boxes are drawn. */
export function DirectVideo({ cam, src, synced, onBroken }: { cam: Camera; src: string; synced: boolean; onBroken: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ring: Overlay[] = [];
    let arrived = 0;
    let shown: Overlay | null | undefined;
    let pal: Palette | null = null;
    const events = new EventSource(apiUrl(`/api/cameras/${encodeURIComponent(cam.id)}/overlay`));
    events.onmessage = (e) => {
      let o: Overlay | null = null;
      try {
        o = JSON.parse(e.data) as Overlay | null;
      } catch {
        return;
      }
      if (!o) return;
      if (ring.length && o.t < ring[ring.length - 1].t - 1) ring.length = 0; // the video started again from the top
      ring.push(o);
      while (ring.length > 60 || (ring.length > 1 && o.t - ring[0].t > 6)) ring.shift();
      arrived = performance.now();
      const v = video.current;
      if (!synced || !v || v.readyState < 1) return;
      const target = Math.max(0, o.t - LAG);
      const drift = target - v.currentTime;
      if (Math.abs(drift) > 3) v.currentTime = target;
      else v.playbackRate = Math.min(1.5, Math.max(0.5, 1 + drift * 0.5));
    };
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const v = video.current;
      const el = canvas.current;
      if (!v || !el) return;
      let pick: Overlay | null = null;
      if (synced) {
        const now = v.currentTime;
        for (let i = ring.length - 1; i >= 0; i--)
          if (ring[i].t <= now + 0.04) {
            if (now - ring[i].t <= STALE) pick = ring[i];
            break;
          }
      } else if (ring.length && performance.now() - arrived < STALE * 1000) pick = ring[ring.length - 1];
      if (pick === shown) return;
      shown = pick;
      const ctx = el.getContext('2d')!;
      if (!pick) {
        ctx.clearRect(0, 0, el.width, el.height);
        return;
      }
      if (el.width !== pick.w || el.height !== pick.h) {
        el.width = pick.w;
        el.height = pick.h;
      } else ctx.clearRect(0, 0, el.width, el.height);
      drawOverlay(ctx, pick, (pal ??= palette(el)));
    };
    frame = requestAnimationFrame(tick);
    return () => {
      events.close();
      cancelAnimationFrame(frame);
    };
  }, [cam.id, synced]);
  return (
    <>
      <video ref={video} className="camview__img" src={src} muted playsInline autoPlay loop={synced} onError={onBroken} />
      <canvas ref={canvas} className="camview__img camview__overlay" aria-hidden="true" />
    </>
  );
}

/** Where the browser can play a camera's video itself, or undefined to use the service's picture stream. An uploaded video
 *  is served by the service as a file; a camera with a view address from a media server (HLS or a plain video file) plays
 *  that, when this browser can. */
export function directSource(cam: Camera): { src: string; synced: boolean } | undefined {
  const s = cam.source;
  if (!s) return undefined;
  if (s.kind === 'upload' && s.uploadId) return { src: apiUrl(`/api/uploads/${encodeURIComponent(s.uploadId)}/video`), synced: true };
  const view = s.viewUrl?.trim();
  if (!view) return undefined;
  if (/\.m3u8(\?|$)/i.test(view) && !document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) return undefined;
  return { src: view, synced: false };
}
