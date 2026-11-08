import { backend, isOnline } from '../lib/backend';
import { qavachRef } from '../lib/refs';
import { createStore, uid, useStore } from '../lib/persist';
import { demoSetup } from '../lib/setup';
import { seedHistory, seedOpenNow } from '../data/history';
import { DOWN_FOR_MIN, AREA_DEPARTMENT, POLICIES, TEAMS, USERS, seedAlerts, seedCameras, seedRules, seedWalls, AREAS } from '../data/seed';
import type { ActivityEntry, Alert, Camera, Policy, QavachRecord, QavachRecordType, Rule, User, Wall } from '../data/types';

// Shared state for every screen. Seed times are relative to the first time the
// prototype opens, so the sample alerts always look recent.

const startedAt = createStore<number>('startedAt', () => Date.now());
const T0 = startedAt.get();
/** When a camera became offline or degraded. Saved data from before this was recorded falls back to the sample times. */
export const unavailableSince = (c: Camera) => c.statusSince ?? T0 - (DOWN_FOR_MIN[c.id] ?? 30) * 60000;
/** A set-up saved from this console (src/data/demo-state.json), when there is one; a first visit starts from it. */
const demo = demoSetup(T0);

export const cameraStore = createStore<Camera[]>('cameras', () => demo?.cameras ?? seedCameras(T0));
export const ruleStore = createStore<Rule[]>('rules', () => demo?.rules ?? seedRules(cameraStore.get(), T0));
export const alertStore = createStore<Alert[]>('alerts', () => demo?.alerts ?? [...seedHistory(T0, cameraStore.get(), ruleStore.get()), ...seedAlerts(T0), ...seedOpenNow(T0, cameraStore.get(), ruleStore.get())]);
export const wallStore = createStore<Wall[]>('walls', () => demo?.walls ?? seedWalls(cameraStore.get()));
export const policyStore = createStore<Policy[]>('policies', () => demo?.policies ?? POLICIES);
export const sessionStore = createStore<{ userId: string; live: boolean }>('session', { userId: 'u-priya', live: true });
const counters = createStore<{ alert: number; Incident: number; Observation: number; 'Near miss': number }>('counters', {
  alert: 1042,
  Incident: 1408,
  Observation: 1586,
  'Near miss': 413,
});

/** Every alert has its own number. Saved data can hold two alerts with one number (a counter that was reset or another window
 *  counted past this one): the oldest keeps it and the later ones are renumbered, so each row opens its own alert and snapshot.
 *  The counter is also moved past the highest number in use. Runs once when the console loads. */
function repairAlertIds() {
  const list = alertStore.get();
  const seen = new Set<string>();
  let top = counters.get().alert - 1;
  for (const a of list) top = Math.max(top, Number(a.id.replace(/\D/g, '')) || 0);
  const oldestFirst = [...list].sort((a, b) => a.at - b.at);
  const rename = new Map<Alert, string>();
  for (const a of oldestFirst) {
    if (seen.has(a.id)) rename.set(a, `ALT-${++top}`);
    seen.add(rename.get(a) ?? a.id);
  }
  if (rename.size) alertStore.set((l) => l.map((a) => (rename.has(a) ? { ...a, id: rename.get(a)! } : a)));
  if (top >= counters.get().alert) counters.set((c) => ({ ...c, alert: top + 1 }));
}
repairAlertIds();

/** When this browser last opened the QHSE reports panel; reports raised after it count as new. */
export const reportsSeenStore = createStore<number>('reportsSeen', 0);

/** Live people/vehicle counts per camera, from the engine. Memory only. */
export const activityStore = createStore<Record<string, number>>('activity', {}, { persist: false });

export const useCameras = () => useStore(cameraStore);
export const useRules = () => useStore(ruleStore);
export const useAlerts = () => useStore(alertStore);
export const useWalls = () => useStore(wallStore);
export const usePolicies = () => useStore(policyStore);
export const useSession = () => useStore(sessionStore);
export const useActivity = () => useStore(activityStore);
export const useReportsSeen = () => useStore(reportsSeenStore);

export const TEAMS_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
export const USERS_BY_ID = Object.fromEntries(USERS.map((u) => [u.id, u]));
export const AREAS_BY_ID = Object.fromEntries(AREAS.map((a) => [a.id, a]));

export const userName = (id?: string) => (id === 'system' ? 'System' : id ? (USERS_BY_ID[id]?.name ?? id) : '');

export function useMe(): User {
  const { userId } = useSession();
  return USERS_BY_ID[userId] ?? USERS[0];
}

export const isAdmin = (u: User) => u.role === 'Safety admin';

/** A role name inside a sentence: lower case, but HSE stays HSE. */
export const roleText = (r: string) => r.toLowerCase().replace('hse', 'HSE');

export const departmentOf = (cam: Camera) => cam.department ?? AREA_DEPARTMENT[cam.areaId] ?? 'Unassigned';
export const teamOfCamera = (cam: Camera) => TEAMS.find((t) => t.id !== 't-hse' && t.areaIds.includes(cam.areaId))?.id ?? 't-hse';

/** People of a role who look after a camera's area: its team first, otherwise anyone with that role. */
export function peopleFor(role: string, cam: Camera): User[] {
  const team = teamOfCamera(cam);
  const inTeam = USERS.filter((u) => u.role === role && u.teamId === team);
  return inTeam.length ? inTeam : USERS.filter((u) => u.role === role);
}

// ── Toasts (memory only) ──────────────────────────────────────────
export interface Toast {
  id: string;
  text: string;
  tone?: 'alert';
  link?: string;
}
export const toastStore = createStore<Toast[]>('toasts', [], { persist: false });
export function toast(text: string, opts: { tone?: 'alert'; link?: string } = {}) {
  const t = { id: uid('t'), text, ...opts };
  toastStore.set((s) => [...s.slice(-3), t]);
  window.setTimeout(() => toastStore.set((s) => s.filter((x) => x.id !== t.id)), opts.tone ? 9000 : 4500);
}

// ── Alerts ────────────────────────────────────────────────────────
function patch(id: string, fn: (a: Alert) => Alert) {
  alertStore.set((list) => list.map((a) => (a.id === id ? fn(a) : a)));
}
const note = (a: Alert, e: ActivityEntry): Alert => ({ ...a, activity: [...a.activity, e] });

export function nextAlertId() {
  let n = 0;
  counters.set((c) => {
    // Never hand out a number an alert already has: another window may have counted past this one, or the counter may
    // have been reset while the alerts were kept.
    const taken = new Set(alertStore.get().map((a) => a.id));
    n = c.alert;
    while (taken.has(`ALT-${n}`)) n++;
    return { ...c, alert: n + 1 };
  });
  return `ALT-${n}`;
}

export function nextQavachRef(type: QavachRecordType) {
  let n = 0;
  counters.set((c) => {
    n = c[type];
    return { ...c, [type]: c[type] + 1 };
  });
  return qavachRef(type, Date.now(), n);
}

export function addAlert(a: Alert) {
  alertStore.set((list) => [a, ...list]);
}

export function acknowledge(id: string, by: string, via: Alert['ackVia'], text?: string) {
  patch(id, (a) =>
    note(
      { ...a, state: 'acknowledged', ackBy: by, ackAt: Date.now(), ackVia: via },
      { at: Date.now(), actor: by, text: `Reviewed ${via === 'mobile' ? 'on the phone' : via === 'wall' ? 'on the video wall' : 'in the console'}${text ? ` · "${text}"` : ''}` },
    ),
  );
}

export function raiseInQavach(id: string, rec: Omit<QavachRecord, 'ref' | 'at'>) {
  const ref = nextQavachRef(rec.type);
  patch(id, (a) =>
    note({ ...a, qavach: { ...rec, ref, at: Date.now() } }, { at: Date.now(), actor: rec.createdBy, text: `${rec.type} ${ref} reported to QHSE` }),
  );
  return ref;
}

export function assign(id: string, to: string, by: string) {
  patch(id, (a) => note({ ...a, assignee: to }, { at: Date.now(), actor: by, text: `Assigned to ${userName(to)}` }));
}

export function escalate(id: string, to: string, by: string, reason: string) {
  patch(id, (a) =>
    note(
      {
        ...a,
        state: a.state === 'new' ? 'escalated' : a.state,
        escalatedTo: to,
        deliveries: [...a.deliveries, { at: Date.now(), to, channel: 'push', status: 'delivered', reason: 'escalation' }, { at: Date.now(), to, channel: 'call', status: 'sent', reason: 'escalation' }],
      },
      { at: Date.now(), actor: by, text: `Escalated to ${userName(to)} · ${reason}` },
    ),
  );
}

export function resolve(id: string, by: string, text: string) {
  patch(id, (a) => note({ ...a, state: 'resolved' }, { at: Date.now(), actor: by, text: `Closed${text ? ` · ${text}` : ''}` }));
}

export function markFalse(id: string, by: string, text: string) {
  patch(id, (a) =>
    note({ ...a, state: 'false-alarm', ackBy: a.ackBy ?? by, ackAt: a.ackAt ?? Date.now() }, { at: Date.now(), actor: by, text: `Marked as a false alarm${text ? ` · ${text}` : ''}` }),
  );
}

export function addDeliveries(id: string, d: Alert['deliveries'], entry?: ActivityEntry) {
  patch(id, (a) => {
    const next = { ...a, deliveries: [...a.deliveries, ...d] };
    return entry ? note(next, entry) : next;
  });
}

export const isOpen = (a: Alert) => a.state === 'new' || a.state === 'escalated';

// ── Cameras, rules, walls, policies ───────────────────────────────
/** Cameras and rules removed while the detection service was not running; it is told as soon as it is back. */
export const removalStore = createStore<{ cameras: string[]; rules: string[] }>('pendingRemovals', { cameras: [], rules: [] });

function removeFromService(kind: 'cameras' | 'rules', id: string) {
  const call = kind === 'cameras' ? () => backend.deleteCamera(id) : () => backend.deleteRule(id);
  if (isOnline()) call().catch(() => removalStore.set((r) => ({ ...r, [kind]: [...r[kind], id] })));
  else removalStore.set((r) => ({ ...r, [kind]: [...new Set([...r[kind], id])] }));
}

/** Tell the detection service about a change, when it is running. When it is not, it gets everything on reconnect. */
function pushToService(what: string, call: () => Promise<unknown>) {
  if (!isOnline()) return;
  call().catch((e: Error) => toast(`Detection service did not accept ${what}: ${e.message}`, { tone: 'alert' }));
}

export { placementFor, setCameraOnRule } from './placement';
import { placementFor } from './placement';
/** The next free camera number in an area: one past the highest in use, so a removed camera's number is never reused over another. */
export function nextCameraId(areaPrefix: string, cams: Camera[]) {
  const nums = cams.filter((c) => c.id.startsWith(`${areaPrefix}-`)).map((c) => Number(c.id.slice(areaPrefix.length + 1))).filter((n) => Number.isFinite(n));
  return `${areaPrefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
}

/** Saves a camera. A new one joins the walls that cover its area unless `place` is false, which the camera editor
 *  uses because it already applied what the admin ticked. */
export function saveCamera(cam: Camera, opts: { place?: boolean } = {}) {
  const isNew = !cameraStore.get().some((c) => c.id === cam.id);
  cameraStore.set((list) => (list.some((c) => c.id === cam.id) ? list.map((c) => (c.id === cam.id ? cam : c)) : [...list, cam]));
  if (cam.source) pushToService(`camera ${cam.id}`, () => backend.putCamera(cam));
  if (!isNew) {
    // A zone taken off the camera also leaves the rules that were using it.
    const kept = new Set(cam.zones.map((z) => z.id));
    const stale = (r: Rule) => r.zoneIds.some((z) => z.startsWith(`${cam.id}-`) && !kept.has(z));
    if (ruleStore.get().some(stale)) {
      ruleStore.set((list) => list.map((r) => (stale(r) ? { ...r, zoneIds: r.zoneIds.filter((z) => !z.startsWith(`${cam.id}-`) || kept.has(z)) } : r)));
      if (cam.source) for (const r of ruleStore.get()) if (r.cameraIds.includes(cam.id)) pushToService(`rule ${r.id}`, () => backend.putRule(r));
    }
    return;
  }
  if (opts.place === false) return;
  // A new camera joins the walls that cover its work area, so it shows up at once. Rules are never added for it: someone picks them.
  const onWalls = new Set(placementFor(cam, wallStore.get()).walls);
  wallStore.set((list) => list.map((w) => (onWalls.has(w.id) && !w.rotation.includes(cam.id) ? { ...w, rotation: [...w.rotation, cam.id] } : w)));
}
export function removeCamera(id: string) {
  const real = cameraStore.get().find((c) => c.id === id)?.source;
  cameraStore.set((list) => list.filter((c) => c.id !== id));
  ruleStore.set((list) => list.map((r) => ({ ...r, cameraIds: r.cameraIds.filter((c) => c !== id), zoneIds: r.zoneIds.filter((z) => !z.startsWith(`${id}-`)) })));
  // Nobody can act on an alert from a camera that is gone, so the ones still open are closed (kept as history).
  for (const a of alertStore.get()) if (a.cameraId === id && a.state !== 'resolved' && a.state !== 'false-alarm') resolve(a.id, 'system', 'Camera was removed');
  wallStore.set((list) => list.map((w) => ({ ...w, pinned: w.pinned.map((p) => (p === id ? null : p)), rotation: w.rotation.filter((c) => c !== id) })));
  if (real) {
    removeFromService('cameras', id);
    for (const r of ruleStore.get()) pushToService(`rule ${r.id}`, () => backend.putRule(r));
  }
}
export function saveRule(rule: Rule) {
  ruleStore.set((list) => (list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? rule : r)) : [...list, rule]));
  pushToService(`rule ${rule.id}`, () => backend.putRule(rule));
}
export function deleteRule(id: string) {
  ruleStore.set((list) => list.filter((r) => r.id !== id));
  removeFromService('rules', id);
}
export function saveWall(wall: Wall) {
  wallStore.set((list) => (list.some((w) => w.id === wall.id) ? list.map((w) => (w.id === wall.id ? wall : w)) : [...list, wall]));
}
export function deleteWall(id: string) {
  wallStore.set((list) => list.filter((w) => w.id !== id));
}
export function savePolicies(p: Policy[]) {
  policyStore.set(() => p);
}

export function nextRuleId(rules: Rule[]) {
  const n = rules.reduce((m, r) => Math.max(m, Number(r.id.replace(/\D/g, '')) || 0), 0) + 1;
  return `R-${String(n).padStart(2, '0')}`;
}
