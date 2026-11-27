// A status report of the detection service in the browser's developer console (F12 → Console), so anyone looking at the
// deployed site can see which cameras and rules are running, which are not and why, and what is slow.
//
//   · every minute: one line of totals, a table of cameras and the rules that are not running
//   · at once, between reports: a camera that stops, fails or starts again, and a camera that turns slow
//   · in the console: qavach.status() prints the report now, qavach.stages() the time each stage takes per camera,
//     qavach.quiet() / qavach.verbose() turn the report off and on (remembered in this browser)
//
// Only this console's own cameras and rules are reported. The detection service may also run cameras and rules kept
// elsewhere (the Sentinel database); those are left out here, as the console leaves out their alerts.
//
// It reads the same /api/events the console already polls (asking for no events, only the camera statuses), on its own
// timer, so it reports in every open window and changes nothing.
import { backend, type CameraStatus } from './backend';
import { cameraStore, ruleStore } from '../state/store';

/** Below this many analysed frames a second a camera is reported as slow: alerts come late and short events are missed. */
const SLOW_FPS = 2;
const POLL_MS = 10_000;
const REPORT_MS = 60_000;
const OFF_KEY = 'qavach.diagnostics';
const TAG = '%c[Qavach]';
const STYLE = 'font-weight:bold';
const WARN = 'font-weight:bold';

interface RuleStatus {
  id: string;
  name: string;
  condition: string;
  status: string;
}
type Status = CameraStatus & {
  stream_fps?: number;
  frames?: number;
  frameMs?: number;
  stageMs?: Record<string, number>;
  ruleStatus?: RuleStatus[];
  position?: number;
};

let started = false;
let last: Record<string, Status> = {};
let lastReport = 0;
let slowNow = new Set<string>();

const quiet = () => {
  try {
    return localStorage.getItem(OFF_KEY) === 'off';
  } catch {
    return false;
  }
};
const nameOf = (id: string) => cameraStore.get().find((c) => c.id === id)?.name ?? '';
const running = (s: Status) => s.state === 'running';
const slow = (s: Status) => running(s) && s.detecting && (s.frames ?? 0) > 2 && (s.frameMs ?? 0) > 1000 / SLOW_FPS;
const slowest = (s: Status) => {
  const entries = Object.entries(s.stageMs ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? `${entries[0][0]} ${Math.round(entries[0][1])} ms` : '';
};
const rulesLine = (s: Status) => {
  const list = s.ruleStatus ?? [];
  return `${list.filter((r) => r.status.startsWith('running')).length} of ${list.length}`;
};

function report(statuses: Record<string, Status>) {
  const ids = Object.keys(statuses).sort();
  const all = ids.map((id) => statuses[id]);
  const rules = all.flatMap((s) => s.ruleStatus ?? []);
  const rulesOn = rules.filter((r) => r.status.startsWith('running')).length;
  const slowIds = ids.filter((id) => slow(statuses[id]));
  const down = ids.filter((id) => !running(statuses[id]));
  const noSource = cameraStore.get().filter((c) => !c.source).length;
  console.info(
    `${TAG} %c${ids.length} of our cameras on the detection service${device ? ` (models on ${device === 'cpu' ? `the CPU, no GPU${runtime === 'openvino' ? ', with OpenVINO' : ', with PyTorch'}` : device})` : ''}: ${ids.length - down.length} running${down.length ? `, ${down.length} not` : ''}` +
      ` · ${rulesOn} of ${rules.length} rules running` +
      (slowIds.length ? ` · ${slowIds.length} slow (under ${SLOW_FPS} frames a second)` : '') +
      (noSource ? ` · ${noSource} cameras on the console have no video and are not analysed` : ''),
    STYLE,
    'font-weight:normal',
  );
  console.table(
    Object.fromEntries(
      ids.map((id) => {
        const s = statuses[id];
        return [
          id,
          {
            location: nameOf(id),
            state: s.state + (s.error ? `: ${s.error}` : ''),
            'rules running': rulesLine(s),
            'frames/s analysed': !running(s) ? '' : s.detecting ? (s.frameMs ? Math.round(10000 / s.frameMs) / 10 : s.fps) : 'preview only',
            'frames/s from camera': s.stream_fps || s.source_fps || '',
            'ms per frame': running(s) && s.frameMs ? Math.round(s.frameMs) : '',
            'slowest stage': running(s) ? slowest(s) : '',
            people: s.people,
            alerts: s.alerts,
            slow: slow(s) ? 'SLOW' : '',
          },
        ];
      }),
    ),
  );
  const off = ids.flatMap((id) => (statuses[id].ruleStatus ?? []).filter((r) => !r.status.startsWith('running')).map((r) => ({ camera: id, rule: `${r.id} ${r.name}`, why: r.status })));
  if (off.length) {
    console.info(`${TAG} %c${off.length} rule${off.length === 1 ? '' : 's'} not running:`, WARN, 'font-weight:normal');
    console.table(off);
  }
  console.info(`${TAG} %cqavach.status() prints this now · qavach.stages() shows the time per stage · qavach.quiet() turns it off`, STYLE, 'font-weight:normal');
}

function stages(statuses: Record<string, Status>) {
  console.info(`${TAG} %cmilliseconds per analysed frame, by stage (smoothed over recent frames)`, STYLE, 'font-weight:normal');
  console.table(
    Object.fromEntries(
      Object.keys(statuses)
        .sort()
        .filter((id) => statuses[id].stageMs && Object.keys(statuses[id].stageMs!).length)
        .map((id) => {
          const s = statuses[id];
          const parts = Object.entries(s.stageMs!).map(([k, v]) => [k, Math.round(v)] as const);
          const counted = parts.reduce((t, [, v]) => t + v, 0);
          // What the stages do not account for: mostly waiting for the shared detector while other cameras use it.
          return [id, { total: Math.round(s.frameMs ?? 0), ...Object.fromEntries(parts), 'waiting and other': Math.max(0, Math.round((s.frameMs ?? 0) - counted)) }];
        }),
    ),
  );
}

/** Changes since the last poll, printed as they happen. */
function changes(now: Record<string, Status>) {
  for (const id of Object.keys(now)) {
    const s = now[id];
    const was = last[id];
    if (!was) continue;
    if (was.state !== s.state || (s.error && s.error !== was.error))
      (running(s) ? console.info : console.warn)(`${TAG} %c${id} ${nameOf(id)}: ${was.state} → ${s.state}${s.error ? ` (${s.error})` : ''}`, running(s) ? STYLE : WARN, 'font-weight:normal');
    if (slow(s) && !slowNow.has(id))
      console.warn(`${TAG} %c${id} ${nameOf(id)} is slow: ${s.fps} frames a second analysed, ${Math.round(s.frameMs ?? 0)} ms a frame, slowest stage ${slowest(s) || 'unknown'}`, WARN, 'font-weight:normal');
  }
  for (const id of Object.keys(last)) if (!now[id]) console.info(`${TAG} %c${id} ${nameOf(id)} left the detection service`, STYLE, 'font-weight:normal');
  slowNow = new Set(Object.keys(now).filter((id) => slow(now[id])));
}

/** The statuses of this console's own cameras, each with only this console's own rules. */
function ours(all: Record<string, Status>) {
  const cams = new Set(cameraStore.get().map((c) => c.id));
  const rules = new Set(ruleStore.get().map((r) => r.id));
  return Object.fromEntries(
    Object.entries(all)
      .filter(([id]) => cams.has(id))
      .map(([id, s]) => [id, { ...s, ruleStatus: (s.ruleStatus ?? []).filter((r) => rules.has(r.id)) }]),
  );
}

let device = '';
let runtime = '';
async function poll(force = false) {
  try {
    if (!device || force) {
      const h = (await backend.health()) as { device?: string | null; runtime?: string | null };
      device = h.device ?? '';
      runtime = h.runtime ?? '';
    }
    const r = await backend.poll(Number.MAX_SAFE_INTEGER);
    const statuses = ours(r.cameras as Record<string, Status>);
    if (!quiet()) {
      changes(statuses);
      if (force || Date.now() - lastReport >= REPORT_MS) {
        report(statuses);
        lastReport = Date.now();
      }
    }
    last = statuses;
    return statuses;
  } catch {
    if (!quiet() && Object.keys(last).length) console.warn(`${TAG} %cthe detection service is not answering`, WARN, 'font-weight:normal');
    last = {};
    return null;
  }
}

/** Start the reports once per window. */
export function startDiagnostics() {
  if (started || typeof window === 'undefined') return;
  started = true;
  (window as unknown as { qavach: unknown }).qavach = {
    status: () => void poll(true),
    stages: async () => {
      const s = await poll();
      if (s) stages(s);
    },
    quiet: () => {
      try {
        localStorage.setItem(OFF_KEY, 'off');
      } catch {
        /* not remembered */
      }
      console.info(`${TAG} %creports off; qavach.verbose() turns them back on`, STYLE, 'font-weight:normal');
    },
    verbose: () => {
      try {
        localStorage.removeItem(OFF_KEY);
      } catch {
        /* not remembered */
      }
      void poll(true);
    },
  };
  window.setTimeout(() => void poll(true), 5000); // after the cameras have had a few seconds to start
  window.setInterval(() => void poll(), POLL_MS);
}
