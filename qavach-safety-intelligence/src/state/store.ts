import { backend, isOnline } from '../lib/backend';
import { createStore, uid, useStore } from '../lib/persist';
import { demoSetup } from '../lib/setup';
import { AREA_DEPARTMENT, POLICIES, TEAMS, USERS, seedAlerts, seedCameras, seedRules, seedWalls, AREAS } from '../data/seed';
import type { ActivityEntry, Alert, Camera, Policy, QavachRecord, QavachRecordType, Rule, User, Wall } from '../data/types';

// Shared state for every screen. Seed times are relative to the first time the
// prototype opens, so the sample alerts always look recent.

const startedAt = createStore<number>('startedAt', () => Date.now());
const T0 = startedAt.get();
/** A set-up saved from this console (src/data/demo-state.json), when there is one; a first visit starts from it. */
const demo = demoSetup(T0);

export const cameraStore = createStore<Camera[]>('cameras', () => demo?.cameras ?? seedCameras(T0));
export const ruleStore = createStore<Rule[]>('rules', () => demo?.rules ?? seedRules(cameraStore.get(), T0));
export const alertStore = createStore<Alert[]>('alerts', () => demo?.alerts ?? seedAlerts(T0));
export const wallStore = createStore<Wall[]>('walls', () => demo?.walls ?? seedWalls(cameraStore.get()));
export const policyStore = createStore<Policy[]>('policies', () => demo?.policies ?? POLICIES);
export const sessionStore = createStore<{ userId: string; live: boolean }>('session', { userId: 'u-priya', live: true });
const counters = createStore<{ alert: number; Incident: number; Observation: number; 'Near miss': number }>('counters', {
  alert: 1042,
  Incident: 413,
  Observation: 1260,
  'Near miss': 188,
});

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
    n = c.alert;
    return { ...c, alert: c.alert + 1 };
  });
  return `ALT-${n}`;
}

export function nextQavachRef(type: QavachRecordType) {
  let n = 0;
  counters.set((c) => {
    n = c[type];
    return { ...c, [type]: c[type] + 1 };
  });
  const p = type === 'Incident' ? 'INC' : type === 'Observation' ? 'OBS' : 'NM';
  return `${p}-26-${String(n).padStart(4, '0')}`;
}

export function addAlert(a: Alert) {
  alertStore.set((list) => [a, ...list]);
}

export function acknowledge(id: string, by: string, via: Alert['ackVia'], text?: string) {
  patch(id, (a) =>
    note(
      { ...a, state: 'acknowledged', ackBy: by, ackAt: Date.now(), ackVia: via },
      { at: Date.now(), actor: by, text: `Acknowledged ${via === 'mobile' ? 'on the phone' : via === 'wall' ? 'on the video wall' : 'in the console'}${text ? ` · "${text}"` : ''}` },
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
  patch(id, (a) => note({ ...a, state: 'resolved' }, { at: Date.now(), actor: by, text: `Resolved${text ? ` · ${text}` : ''}` }));
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

/** Where a camera belongs without anyone ticking boxes: the walls of the teams that cover its work area, and the rules
 *  that already watch other cameras of that work area (taking its zones of the same names as the rule's zones). */
export function placementFor(cam: Camera, cams: Camera[], rules: Rule[], walls: Wall[]) {
  const peers = cams.filter((c) => c.id !== cam.id && c.areaId === cam.areaId);
  const ruleZones = (r: Rule) => {
    const names = new Set(cams.filter((c) => c.id !== cam.id).flatMap((c) => c.zones.filter((z) => r.zoneIds.includes(z.id)).map((z) => z.name)));
    return cam.zones.filter((z) => names.has(z.name)).map((z) => z.id);
  };
  return {
    walls: walls.filter((w) => TEAMS_BY_ID[w.teamId]?.areaIds.includes(cam.areaId)).map((w) => w.id),
    // A rule drawn on zones only takes a camera that has a zone of the same name; a whole-view rule takes any camera of the area.
    rules: rules.filter((r) => peers.some((p) => r.cameraIds.includes(p.id)) && (r.zoneIds.length === 0 || ruleZones(r).length > 0)).map((r) => ({ id: r.id, zoneIds: ruleZones(r) })),
  };
}

/** Puts a camera on or off a rule, with the zones that go with it. */
export function setCameraOnRule(rule: Rule, cam: Camera, on: boolean, zoneIds: string[]): Rule {
  const rest = rule.cameraIds.filter((id) => id !== cam.id);
  const zones = rule.zoneIds.filter((z) => !cam.zones.some((cz) => cz.id === z));
  return on ? { ...rule, cameraIds: [...rest, cam.id], zoneIds: [...zones, ...zoneIds] } : { ...rule, cameraIds: rest, zoneIds: zones };
}

export function saveCamera(cam: Camera) {
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
  // A new camera joins the walls and rules that already cover its work area, so it shows up everywhere at once.
  // A connected camera (one with a real stream) is left off rules until someone chooses, since a rule starts real detection on it.
  const place = placementFor(cam, cameraStore.get(), ruleStore.get(), wallStore.get());
  const onWalls = new Set(place.walls);
  wallStore.set((list) => list.map((w) => (onWalls.has(w.id) && !w.rotation.includes(cam.id) ? { ...w, rotation: [...w.rotation, cam.id] } : w)));
  if (!cam.source) {
    const byRule = new Map(place.rules.map((r) => [r.id, r.zoneIds]));
    ruleStore.set((list) => list.map((r) => (byRule.has(r.id) ? setCameraOnRule(r, cam, true, byRule.get(r.id)!) : r)));
  }
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
