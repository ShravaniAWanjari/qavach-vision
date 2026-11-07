import type { Alert, Camera, Policy, Priority, Rule } from '../data/types';

// What an operations admin needs from the alerts, worked out in one place: which things are open and overdue, what was
// handled but never reported, where and when alerts come from, and which rules and cameras need attention. The Overview
// screens and its export both read from these, so they always agree.

export const MIN = 60000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const LEVELS: Priority[] = ['P1', 'P2', 'P3', 'P4'];

export const isOpenAlert = (a: Alert) => a.state === 'new' || a.state === 'escalated';
const isHandled = (a: Alert) => a.state === 'acknowledged' || a.state === 'resolved' || a.state === 'false-alarm';
const targetMs = (policies: Policy[], p: Priority) => (policies.find((x) => x.priority === p)?.reviewWithinSec ?? 900) * 1000;
export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
export const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);

// ── Action Centre ─────────────────────────────────────────────────────────────────────────

/** The same thing seen more than once: open alerts for one rule on one camera. */
export interface Issue {
  key: string;
  ruleId: string;
  cameraId: string;
  title: string;
  priority: Priority;
  /** Detections in all: each open alert plus the repeats counted on it. */
  count: number;
  first: number;
  last: number;
  state: 'new' | 'escalated';
  /** The most recent alert: what Acknowledge and Open act on. */
  lead: Alert;
  /** Milliseconds past the level's response target (0 while still inside it). */
  overdue: number;
  /** Milliseconds left to respond; negative once past. */
  left: number;
}

export function openIssues(alerts: Alert[], policies: Policy[], now: number): Issue[] {
  const groups = new Map<string, Alert[]>();
  for (const a of alerts.filter(isOpenAlert)) {
    const key = `${a.ruleId}|${a.cameraId}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const issues: Issue[] = [];
  for (const [key, list] of groups) {
    const byTime = [...list].sort((a, b) => a.at - b.at);
    const lead = byTime[byTime.length - 1];
    const first = byTime[0].at;
    const left = first + targetMs(policies, lead.priority) - now;
    issues.push({
      key,
      ruleId: lead.ruleId,
      cameraId: lead.cameraId,
      title: lead.title,
      priority: lead.priority,
      count: list.reduce((s, a) => s + 1 + (a.repeats ?? 0), 0),
      first,
      last: Math.max(...list.map((a) => a.lastAt ?? a.at)),
      state: list.some((a) => a.state === 'escalated') ? 'escalated' : 'new',
      lead,
      overdue: Math.max(0, -left),
      left,
    });
  }
  // Past the response target first, then the higher level, then the oldest.
  return issues.sort((a, b) => Number(b.overdue > 0) - Number(a.overdue > 0) || a.priority.localeCompare(b.priority) || a.first - b.first);
}

/** Handled P1 and P2 alerts whose rule asks for a QHSE record and that have none. Newest first inside a level. */
export function unreportedAlerts(alerts: Alert[], rules: Rule[], from = 0, to = Infinity): Alert[] {
  const record = new Map(rules.map((r) => [r.id, r.qavach]));
  return alerts
    .filter((a) => a.at >= from && a.at <= to && (a.priority === 'P1' || a.priority === 'P2') && !a.qavach && (a.state === 'acknowledged' || a.state === 'resolved') && (record.get(a.ruleId) ?? 'none') !== 'none')
    .sort((a, b) => a.priority.localeCompare(b.priority) || b.at - a.at);
}

/** Cameras that are not live, and which rules lose them: a rule that watches only broken cameras sees nothing. */
export function cameraImpact(cam: Camera, rules: Rule[], cams: Camera[]) {
  const watching = rules.filter((r) => r.cameraIds.includes(cam.id));
  const blind = watching.filter((r) => r.mode === 'live' && r.cameraIds.every((id) => cams.find((c) => c.id === id)?.status === 'offline'));
  return { watching, blind };
}

// ── Insights ──────────────────────────────────────────────────────────────────────────────

export interface Sla {
  met: number;
  missed: number;
  /** Share answered inside the target, among those whose time is up. */
  pct: number | null;
  /** The worst miss: how late, and which alert. */
  worst?: { alert: Alert; late: number };
  byLevel: { p: Priority; met: number; missed: number }[];
}

/** An alert counts as answered in time when it was acknowledged within its level's target; as missed when it was acknowledged
 *  later, or is still open and past the target. False alarms marked without an acknowledgement are left out. */
export function responseStats(list: Alert[], policies: Policy[], now: number): Sla {
  let met = 0;
  let missed = 0;
  let worst: Sla['worst'];
  const byLevel = LEVELS.map((p) => ({ p, met: 0, missed: 0 }));
  for (const a of list) {
    const t = targetMs(policies, a.priority);
    let late = 0;
    let ok: boolean | undefined;
    if (a.ackAt) {
      late = a.ackAt - a.at - t;
      ok = late <= 0;
    } else if (isOpenAlert(a) && now - a.at > t) {
      late = now - a.at - t;
      ok = false;
    }
    if (ok === undefined) continue;
    const row = byLevel.find((x) => x.p === a.priority)!;
    if (ok) {
      met++;
      row.met++;
    } else {
      missed++;
      row.missed++;
      if (!worst || late > worst.late) worst = { alert: a, late };
    }
  }
  return { met, missed, pct: pct(met, met + missed), worst, byLevel };
}

export interface Hotspot {
  cameraId: string;
  count: number;
  before: number;
  open: number;
  topRule: string;
  topRuleCount: number;
  /** Share of this camera's alerts that were false alarms. */
  falsePct: number | null;
}

export function hotspots(list: Alert[], previous: Alert[], rules: Rule[]): Hotspot[] {
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));
  const byCam = new Map<string, Alert[]>();
  for (const a of list) byCam.set(a.cameraId, [...(byCam.get(a.cameraId) ?? []), a]);
  const out: Hotspot[] = [];
  for (const [cameraId, as] of byCam) {
    const rc = new Map<string, number>();
    for (const a of as) rc.set(a.ruleId, (rc.get(a.ruleId) ?? 0) + 1);
    const [topId, topN] = [...rc.entries()].sort((x, y) => y[1] - x[1])[0];
    const handled = as.filter(isHandled);
    out.push({
      cameraId,
      count: as.length,
      before: previous.filter((a) => a.cameraId === cameraId).length,
      open: as.filter(isOpenAlert).length,
      topRule: ruleName.get(topId) ?? topId,
      topRuleCount: topN,
      falsePct: pct(handled.filter((a) => a.state === 'false-alarm').length, handled.length),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface RuleHealth {
  rule: Rule;
  alerts: number;
  handled: number;
  falseAlarms: number;
  falsePct: number | null;
  avgAck: number | null;
  open: number;
  /** What to do about it, when there is something. */
  flag?: { kind: 'noisy' | 'silent' | 'slow'; text: string };
}

export function ruleHealth(list: Alert[], rules: Rule[], policies: Policy[], spanMs: number): RuleHealth[] {
  return rules
    .map((rule) => {
      const as = list.filter((a) => a.ruleId === rule.id);
      const handled = as.filter(isHandled);
      const falseAlarms = handled.filter((a) => a.state === 'false-alarm').length;
      const acks = as.filter((a) => a.ackAt && a.ackAt >= a.at).map((a) => a.ackAt! - a.at);
      const avgAck = mean(acks);
      const falsePct = pct(falseAlarms, handled.length);
      let flag: RuleHealth['flag'];
      if (handled.length >= 5 && (falsePct ?? 0) >= 20) flag = { kind: 'noisy', text: `${falsePct}% false alarms` };
      else if (avgAck !== null && acks.length >= 3 && avgAck > targetMs(policies, rule.priority) * 1.2) flag = { kind: 'slow', text: 'Answered slower than the target' };
      else if (rule.mode === 'live' && as.length === 0 && spanMs >= 3 * DAY) flag = { kind: 'silent', text: 'No alerts in this period' };
      return { rule, alerts: as.length, handled: handled.length, falseAlarms, falsePct, avgAck, open: as.filter(isOpenAlert).length, flag };
    })
    .filter((r) => r.alerts > 0 || r.flag)
    .sort((a, b) => Number(!!b.flag) - Number(!!a.flag) || b.alerts - a.alerts);
}

export interface HourPattern {
  /** Alerts at each hour of the day, summed over the period. */
  counts: number[];
  peak: number;
  /** The peak hour against the average hour. */
  peakTimes: number;
  /** Alerts per shift: 06:00 to 18:00 and 18:00 to 06:00. */
  day: number;
  night: number;
}

export function hourPattern(list: Alert[]): HourPattern {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const a of list) counts[new Date(a.at).getHours()]++;
  const total = counts.reduce((s, n) => s + n, 0);
  const peak = counts.indexOf(Math.max(...counts));
  const day = counts.slice(6, 18).reduce((s, n) => s + n, 0);
  return { counts, peak, peakTimes: total ? counts[peak] / (total / 24) : 0, day, night: total - day };
}

export interface Finding {
  tone: 'bad' | 'warn' | 'info';
  text: string;
  to: string;
  label: string;
}

/** The few things in the period worth acting on, most urgent first, each with where to go to act. */
export function findings(input: {
  list: Alert[];
  previous: Alert[];
  sla: Sla;
  hot: Hotspot[];
  rulesHealth: RuleHealth[];
  unreported: number;
  pattern: HourPattern;
  spanMs: number;
  camName: (id: string) => string;
  ruleName: (id: string) => string;
}): Finding[] {
  const { list, previous, sla, hot, rulesHealth, unreported, pattern, spanMs } = input;
  const out: Finding[] = [];
  if (sla.pct !== null && sla.pct < 90 && sla.met + sla.missed >= 5) {
    const w = sla.worst;
    out.push({
      tone: sla.pct < 75 ? 'bad' : 'warn',
      text: `${sla.missed} of ${sla.met + sla.missed} alerts were not reviewed within their target (${sla.pct}% on time).${w ? ` The worst was ${Math.round(w.late / MIN)} min late: ${w.alert.title} on ${w.alert.cameraId}.` : ''}`,
      to: w ? `/alerts/${w.alert.id}` : '/alerts',
      label: 'Review the worst',
    });
  }
  if (unreported > 0) {
    out.push({ tone: unreported >= 5 ? 'bad' : 'warn', text: `${unreported} handled P1 and P2 alerts have no QHSE report.`, to: '/', label: 'Report them' });
  }
  const noisy = rulesHealth.find((r) => r.flag?.kind === 'noisy');
  if (noisy) {
    out.push({ tone: 'warn', text: `${noisy.rule.name}: ${noisy.falsePct}% of its handled alerts (${noisy.falseAlarms} of ${noisy.handled}) were false alarms. Tighten its zones or how long it waits before alerting.`, to: `/configuration/rules/${noisy.rule.id}`, label: 'Tune the rule' });
  }
  const typical = hot.length ? hot.map((h) => h.count).sort((a, b) => a - b)[Math.floor(hot.length / 2)] : 0;
  const top = hot.find((h) => h.count >= 6 && h.count >= 2.5 * Math.max(1, typical) && h.count > h.before * 1.4);
  if (top) {
    out.push({
      tone: 'warn',
      text: `${top.cameraId} ${input.camName(top.cameraId)} raised ${top.count} alerts, ${top.before ? `up from ${top.before}` : 'none before'}. Most are ${top.topRule.toLowerCase()} (${top.topRuleCount}). Look for a cause on site, not just at the alerts.`,
      to: `/alerts?camera=${encodeURIComponent(top.cameraId)}`,
      label: 'See its alerts',
    });
  }
  if (spanMs >= 2 * DAY && list.length >= 20 && pattern.peakTimes >= 2) {
    const h = (n: number) => String(n).padStart(2, '0');
    out.push({ tone: 'info', text: `Alerts peak between ${h(pattern.peak)}:00 and ${h((pattern.peak + 1) % 24)}:00, about ${pattern.peakTimes.toFixed(1)} times the average hour. Plan extra cover around it.`, to: '/wall', label: 'Open the video wall' });
  }
  const silent = rulesHealth.filter((r) => r.flag?.kind === 'silent');
  if (silent.length) {
    out.push({ tone: 'info', text: `${silent.length === 1 ? silent[0].rule.name : `${silent.length} live rules`} raised nothing in this period. Check the cameras and zones still cover the area.`, to: silent.length === 1 ? `/configuration/rules/${silent[0].rule.id}` : '/rules', label: silent.length === 1 ? 'Check the rule' : 'See the rules' });
  }
  if (previous.length >= 10 && list.length) {
    const change = Math.round(((list.length - previous.length) / previous.length) * 100);
    if (Math.abs(change) >= 25) out.push({ tone: change > 0 ? 'warn' : 'info', text: `Alerts are ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on the period before (${previous.length} to ${list.length}).`, to: '/alerts', label: 'See alerts' });
  }
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 5);
}

// ── Short windows: the last few minutes ───────────────────────────────────────────────────

/** What a window of this length usually holds at this time of day: the same window on each of the previous days, averaged.
 *  Days with nothing in them count as zero, so a quiet hour reads as quiet. */
export function normalFor(alerts: Alert[], end: number, spanMs: number, days = 14) {
  const by: Record<Priority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let total = 0;
  let counted = 0;
  for (let d = 1; d <= days; d++) {
    const to = end - d * DAY;
    const from = to - spanMs;
    // Only days the history covers: from the oldest alert on.
    if (alerts.length && from < Math.min(...alerts.map((a) => a.at))) continue;
    counted++;
    for (const a of alerts) {
      if (a.at > from && a.at <= to) {
        total++;
        by[a.priority]++;
      }
    }
  }
  const mean1 = (n: number) => (counted ? n / counted : 0);
  return { days: counted, total: mean1(total), byLevel: LEVELS.map((p) => ({ p, n: mean1(by[p]) })) };
}

/** The few things worth saying about the last few minutes, most urgent first. */
export function liveFindings(input: {
  list: Alert[];
  issues: Issue[];
  normal: ReturnType<typeof normalFor>;
  minutes: number;
  camName: (id: string) => string;
}): Finding[] {
  const { list, issues, normal, minutes } = input;
  const out: Finding[] = [];
  const late = issues.filter((i) => i.overdue > 0);
  if (late.length) {
    const worst = [...late].sort((a, b) => b.overdue - a.overdue)[0];
    out.push({ tone: 'bad', text: `${late.length === 1 ? '1 issue is' : `${late.length} issues are`} past the response target. Longest: ${worst.title} on ${worst.cameraId}, ${Math.round(worst.overdue / MIN)} min over.`, to: '/', label: 'Open the Action Centre' });
  }
  const p1 = list.filter((a) => a.priority === 'P1' && isOpenAlert(a));
  if (p1.length) out.push({ tone: 'bad', text: `${p1.length === 1 ? 'A P1 alert is' : `${p1.length} P1 alerts are`} still waiting: ${p1[0].title} on ${p1[0].cameraId}.`, to: `/alerts/${p1[0].id}`, label: 'Open it' });
  if (normal.days >= 3 && list.length >= 2 && normal.total > 0 && list.length >= 2 * normal.total) {
    out.push({ tone: 'warn', text: `${list.length} alerts in the last ${minutes} min, ${(list.length / normal.total).toFixed(1)} times the usual ${normal.total.toFixed(1)} for this time of day.`, to: '/alerts', label: 'See the alerts' });
  } else if (normal.days >= 3 && list.length === 0 && normal.total >= 1.5) {
    out.push({ tone: 'info', text: `No alerts in the last ${minutes} min, against a usual ${normal.total.toFixed(1)} for this time of day. Quiet, or a camera is not reporting.`, to: '/cameras?coverage=issues', label: 'Check the cameras' });
  }
  const byCam = new Map<string, number>();
  for (const a of list) byCam.set(a.cameraId, (byCam.get(a.cameraId) ?? 0) + 1 + (a.repeats ?? 0));
  const [camId, n] = [...byCam.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (n >= 3) out.push({ tone: 'warn', text: `${camId} ${input.camName(camId)} has ${n} detections in ${minutes} min. Someone may need to go and look.`, to: `/alerts?camera=${encodeURIComponent(camId)}`, label: 'See its alerts' });
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 4);
}

/** The open issue whose response time runs out soonest, if any is still inside its target. */
export function nextDeadline(issues: Issue[]): Issue | undefined {
  return issues.filter((i) => i.left > 0).sort((a, b) => a.left - b.left)[0];
}

const SEEN_RANK = { read: 3, delivered: 2, sent: 1, failed: 0 } as const;

/** The people an alert went to, each with the best news about them: read it, got it, was sent it, or could not be reached. */
export function peopleTold(alert: Alert) {
  const by = new Map<string, { to: string; status: keyof typeof SEEN_RANK; escalation: boolean; channels: Set<string> }>();
  for (const d of alert.deliveries) {
    const cur = by.get(d.to);
    if (!cur) by.set(d.to, { to: d.to, status: d.status, escalation: d.reason === 'escalation', channels: new Set([d.channel]) });
    else {
      cur.channels.add(d.channel);
      if (SEEN_RANK[d.status] > SEEN_RANK[cur.status]) cur.status = d.status;
      if (d.reason === 'escalation') cur.escalation = true;
    }
  }
  return [...by.values()].sort((a, b) => Number(a.escalation) - Number(b.escalation) || SEEN_RANK[b.status] - SEEN_RANK[a.status]);
}
