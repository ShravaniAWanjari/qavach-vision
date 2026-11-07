import type { Alert, Camera, Delivery, Priority, QavachRecord, QavachRecordType, Rule } from './types';
import { describeRule, draftRecord } from '../lib/qai';
import { AREAS, POLICIES } from './seed';

// Four weeks of believable history for the sample site, so the Overview has something real to work with: the daily rhythm of
// a port (busy at the shift changes, quiet at night), a few cameras that keep coming up, rules that cry wolf more than others,
// supervisors who usually answer within the target and sometimes do not, and a handful of handled alerts nobody reported.
// Every number comes from a fixed seed, so the history is the same on every machine.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAYS = 28;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often each rule fires relative to the others, how often a handled alert turns out false, and when in the day. */
const PROFILE: Record<string, { weight: number; falseRate: number; when: 'day' | 'night' | 'flat' }> = {
  'R-01': { weight: 14, falseRate: 0.1, when: 'day' },
  'R-02': { weight: 7, falseRate: 0.06, when: 'day' },
  'R-03': { weight: 6, falseRate: 0.08, when: 'day' },
  'R-04': { weight: 26, falseRate: 0.07, when: 'day' },
  'R-05': { weight: 12, falseRate: 0.36, when: 'day' },
  'R-06': { weight: 3, falseRate: 0.12, when: 'flat' },
  'R-07': { weight: 3, falseRate: 0.25, when: 'day' },
  'R-08': { weight: 9, falseRate: 0.3, when: 'day' },
  'R-09': { weight: 6, falseRate: 0.4, when: 'night' },
};

// Relative activity by hour of day. Shift changes at 06:00 and 18:00 are the busy times.
const DAY_HOURS = [0.2, 0.15, 0.1, 0.1, 0.15, 0.5, 2.2, 2.6, 1.8, 1.3, 1.2, 1.3, 1.1, 1.5, 1.6, 1.3, 1.2, 1.5, 2.0, 1.4, 0.7, 0.4, 0.3, 0.25];
const NIGHT_HOURS = [1.6, 1.5, 1.4, 1.5, 1.2, 0.6, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8, 1.8, 2.0, 2.0, 1.9, 1.8, 1.7];
const hourWeights = (when: 'day' | 'night' | 'flat') => (when === 'night' ? NIGHT_HOURS : when === 'flat' ? Array.from({ length: 24 }, () => 1) : DAY_HOURS);

const SUPERVISOR: Record<string, string> = { quay: 'u-rahul', deck: 'u-rahul', yard: 'u-sana', reefer: 'u-sana', gate: 'u-sana', hazmat: 'u-vikram', workshop: 'u-vikram', perimeter: 'u-sana' };
const ACTION: Record<string, string> = {
  'R-01': 'Worker told to use the walkway',
  'R-02': 'Work stopped until a life jacket was worn',
  'R-03': 'Area cleared and the crane operator told',
  'R-04': 'Worker stopped and PPE issued',
  'R-05': 'Worker moved out of the RTG lane',
  'R-06': 'Access to the bay stopped, supervisor sent',
  'R-07': 'Area checked, no fire found',
  'R-08': 'Driver asked to move on',
  'R-09': 'Perimeter patrol sent',
};
const SEVERITY: Record<Priority, QavachRecord['severity']> = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };

function pickWeighted<T>(items: T[], weights: number[], r: number): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

const OPERATOR: Record<string, string> = { quay: 'u-arun', deck: 'u-arun', yard: 'u-meera', reefer: 'u-meera', gate: 'u-meera' };

/** Who the notification policy tells for this alert, on which channels, and whether they have seen it: most have read it a
 *  couple of minutes on, an occasional text or call fails, and an escalation goes to the next person up. */
function toldAbout(rule: Rule, cam: Camera, at: number, now: number, r: () => number, escalated: boolean): Delivery[] {
  const policy = POLICIES.find((p) => p.priority === rule.priority)!;
  const out: Delivery[] = [];
  const age = now - at;
  const seen = (p: number) => (age > 2 * MIN && r() < p ? 'read' : 'delivered');
  if (policy.channels.includes('wall')) out.push({ at, to: OPERATOR[cam.areaId] ?? 'u-arun', channel: 'wall', status: seen(0.8), reason: 'alert' });
  const roleUser = (role: string) => (role === 'Shift supervisor' ? (SUPERVISOR[cam.areaId] ?? 'u-rahul') : role === 'HSE manager' ? 'u-vikram' : role === 'Terminal manager' ? 'u-daniel' : (OPERATOR[cam.areaId] ?? 'u-arun'));
  for (const role of policy.notify) {
    for (const channel of policy.channels.filter((c) => c !== 'wall')) {
      const failed = (channel === 'sms' || channel === 'call') && r() < 0.12;
      out.push({ at, to: roleUser(role), channel, status: failed ? 'failed' : channel === 'call' ? 'sent' : seen(0.7), reason: 'alert' });
    }
  }
  if (escalated && policy.escalateTo !== 'none') out.push({ at: at + policy.ackWithinMin * MIN, to: roleUser(policy.escalateTo), channel: 'push', status: age > policy.ackWithinMin * MIN + 3 * MIN && r() < 0.5 ? 'read' : 'delivered', reason: 'escalation' });
  return out;
}

/** One alert, built the way the engine builds them, with the outcome already decided. */
function build(opts: {
  id: string;
  rule: Rule;
  cam: Camera;
  at: number;
  now: number;
  r: () => number;
  state?: 'open-new' | 'open-escalated';
  refs: Record<QavachRecordType, number>;
  forceUnreported?: boolean;
}): Alert {
  const { rule, cam, at, now, r } = opts;
  const policy = POLICIES.find((p) => p.priority === rule.priority)!;
  const target = policy.ackWithinMin * MIN;
  const zone = cam.zones.find((z) => rule.zoneIds.includes(z.id));
  const confidence = 0.74 + r() * 0.24;
  const seconds = rule.durationSec + 1 + Math.floor(r() * 6);
  const base: Alert = {
    id: opts.id,
    ruleId: rule.id,
    cameraId: cam.id,
    zoneId: zone?.id,
    priority: rule.priority,
    title: rule.name,
    detail: `${describeRule(rule, zone ? [zone.name] : [])} · ${seconds}s · ${Math.round(confidence * 100)}% confidence`,
    at,
    state: 'new',
    box: [20 + Math.floor(r() * 55), 28 + Math.floor(r() * 40), 6 + Math.floor(r() * 6), 14 + Math.floor(r() * 12)],
    confidence,
    deliveries: [],
    activity: [{ at, text: 'Detected by the edge model', actor: 'system' }],
  };
  if (opts.state === 'open-new') return { ...base, deliveries: toldAbout(rule, cam, at, now, r, false) };
  if (opts.state === 'open-escalated') {
    return {
      ...base,
      deliveries: toldAbout(rule, cam, at, now, r, true),
      state: 'escalated',
      escalatedTo: policy.escalateTo === 'none' ? undefined : policy.escalateTo === 'Terminal manager' ? 'u-daniel' : 'u-vikram',
      activity: [...base.activity, { at: at + target, text: `Not acknowledged within ${policy.ackWithinMin} min · escalated`, actor: 'system' }],
    };
  }

  const area = cam.areaId;
  const who = SUPERVISOR[area] ?? 'u-rahul';
  const night = new Date(at).getHours() >= 18 || new Date(at).getHours() < 6;
  const breached = r() < (night ? 0.2 : 0.11);
  const delay = breached ? target * (1.25 + r() * 3) : target * (0.12 + r() * 0.75);
  const ackAt = at + delay;
  // Not yet acknowledged at this moment: it is still open, as a fresh alert or one past its target.
  if (ackAt > now) return build({ ...opts, state: now - at > target ? 'open-escalated' : 'open-new' });
  const activity = [...base.activity];
  if (breached) activity.push({ at: at + target, text: `Not acknowledged within ${policy.ackWithinMin} min · escalated`, actor: 'system' });
  activity.push({ at: ackAt, text: 'Acknowledged in the console', actor: who });

  const profile = PROFILE[rule.id];
  const isFalse = r() < (profile?.falseRate ?? 0.1);
  const closedAt = ackAt + (isFalse ? 1 + r() * 6 : 6 + r() * 38) * MIN;
  activity.push({ at: closedAt, text: isFalse ? 'Marked as a false alarm' : `Resolved · ${ACTION[rule.id] ?? 'Checked and cleared'}`, actor: who });
  // Acknowledged but still being dealt with.
  if (closedAt > now) {
    return { ...base, deliveries: toldAbout(rule, cam, at, now, r, breached), state: 'acknowledged', ackBy: who, ackAt, ackVia: 'console', activity, escalatedTo: breached ? 'u-vikram' : undefined };
  }
  const out: Alert = { ...base, state: isFalse ? 'false-alarm' : 'resolved', ackBy: who, ackAt, ackVia: 'console', activity };
  if (breached) out.escalatedTo = 'u-vikram';

  // A QHSE record for most handled P1 and P2 alerts whose rule asks for one. The last day and a half has a few that nobody got to.
  const wants = !isFalse && (rule.priority === 'P1' || rule.priority === 'P2') && rule.qavach !== 'none';
  const recent = now - at < 36 * HOUR;
  const skip = opts.forceUnreported || r() < (recent ? 0.45 : 0.04);
  if (wants && !skip && closedAt < now) {
    const type = rule.qavach as QavachRecordType;
    const n = opts.refs[type]--;
    const prefix = type === 'Incident' ? 'INC' : type === 'Observation' ? 'OBS' : 'NM';
    const draft = draftRecord(out, cam, rule, AREAS.find((a) => a.id === cam.areaId), new Date(at).toTimeString().slice(0, 5));
    out.qavach = { ...draft, ref: `${prefix}-26-${String(n).padStart(4, '0')}`, createdBy: who, source: r() < 0.3 ? 'auto' : 'manual', at: closedAt + 2 * MIN, severity: SEVERITY[rule.priority], immediateAction: ACTION[rule.id] ?? draft.immediateAction };
  }
  return out;
}

/** The past four weeks, oldest first, the newest 25 minutes ago. */
export function seedHistory(now: number, cams: Camera[], rules: Rule[]): Alert[] {
  const r = rng(20261107);
  const camById = new Map(cams.map((c) => [c.id, c]));
  const usable = rules.filter((x) => PROFILE[x.id] && x.mode === 'live' && x.cameraIds.length);
  if (!usable.length) return [];
  const planned: { rule: Rule; cam: Camera; at: number }[] = [];

  for (let d = DAYS; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekend = [0, 6].includes(dayStart.getDay());
    // Gently improving over the month, with a flare-up in the last two days at one apron camera.
    const trend = 1.18 - 0.3 * ((DAYS - d) / DAYS);
    const count = Math.round((weekend ? 11 + r() * 5 : 19 + r() * 9) * trend);
    for (let i = 0; i < count; i++) {
      const rule = pickWeighted(usable, usable.map((x) => PROFILE[x.id].weight), r());
      const hour = pickWeighted([...Array(24).keys()], hourWeights(PROFILE[rule.id].when), r());
      const at = dayStart.getTime() + hour * HOUR + Math.floor(r() * 60) * MIN + Math.floor(r() * 60) * 1000;
      if (at > now - 25 * MIN) continue;
      // The first cameras in a rule's list come up most: they cover the busiest spots.
      const ids = rule.cameraIds.filter((id) => camById.has(id));
      const cam = camById.get(pickWeighted(ids, ids.map((_, k) => 1 / Math.pow(k + 1, 0.95)), r()))!;
      planned.push({ rule, cam, at });
    }
    if (d <= 2 && camById.has('QUA-08')) {
      const rule = usable.find((x) => x.id === 'R-04');
      if (rule) for (let i = 0; i < 4 + (d === 0 ? 0 : 2); i++) planned.push({ rule, cam: camById.get('QUA-08')!, at: dayStart.getTime() + (8 + i * 1.7) * HOUR });
    }
  }
  planned.sort((a, b) => a.at - b.at);
  const refs: Record<QavachRecordType, number> = { Incident: 412, Observation: 1259, 'Near miss': 187 };
  const out: Alert[] = [];
  // Newest first so the QHSE reference numbers count down from the sample counters.
  const newestFirst = [...planned].reverse();
  const made = newestFirst.map((p, i) => build({ id: `ALT-${String(900 - i).padStart(4, '0')}`, rule: p.rule, cam: p.cam, at: p.at, now, r, refs }));
  out.push(...made.reverse());
  return out;
}

/** A few alerts still open right now, at different ages: just in, waiting, and past the response target. */
export function seedOpenNow(now: number, cams: Camera[], rules: Rule[]): Alert[] {
  const r = rng(77);
  const refs: Record<QavachRecordType, number> = { Incident: 0, Observation: 0, 'Near miss': 0 };
  const plan: { id: string; rule: string; cam: string; ago: number; state: 'open-new' | 'open-escalated' }[] = [
    { id: 'ALT-1035', rule: 'R-02', cam: 'DCK-02', ago: 9, state: 'open-escalated' },
    { id: 'ALT-1034', rule: 'R-05', cam: 'YRD-18', ago: 24, state: 'open-escalated' },
    { id: 'ALT-1033', rule: 'R-03', cam: 'QUA-04', ago: 1.5, state: 'open-new' },
    { id: 'ALT-1032', rule: 'R-04', cam: 'QUA-08', ago: 11, state: 'open-new' },
    { id: 'ALT-1031', rule: 'R-08', cam: 'GTE-04', ago: 38, state: 'open-new' },
  ];
  const out: Alert[] = [];
  for (const p of plan) {
    const rule = rules.find((x) => x.id === p.rule);
    const cam = cams.find((c) => c.id === p.cam);
    if (rule && cam) out.push(build({ id: p.id, rule, cam, at: now - p.ago * MIN, now, r, state: p.state, refs }));
  }
  return out;
}
