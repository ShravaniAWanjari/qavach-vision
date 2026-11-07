import { useEffect, useRef, useState } from 'react';
import { cssVar } from '../styles/colors';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AckDialog, RaiseDialog } from '../components/AlertDialogs';
import { Icon, type IconName } from '../components/Icon';
import { QavachReportsDrawer } from '../components/QavachReports';
import { Choice, PillTabs, PriorityBadge, StateChip, useConfirm } from '../components/ui';
import { SITE } from '../data/seed';
import type { Alert, Priority, QavachRecordType } from '../data/types';
import { healthReason } from '../lib/health';
import { cameraImpact, DAY, findings, HOUR, hotspots, hourPattern, isOpenAlert, LEVELS, liveFindings, mean, MIN, nextDeadline, normalFor, openIssues, pct, peopleTold, responseStats, ruleHealth, unreportedAlerts, type Issue } from '../lib/ops';
import { dataUrlBytes, jpegToPdf } from '../lib/pdf';
import { draftRecord } from '../lib/qai';
import { download, writeXlsx, type Cell } from '../lib/sheet';
import { ago, duration, hm, useNow } from '../lib/time';
import { acknowledge, alertStore, AREAS_BY_ID, raiseInQavach, toast, unavailableSince, useAlerts, userName, useCameras, useMe, usePolicies, useRules } from '../state/store';
import './overview.css';

type Range = '5m' | '10m' | '15m' | 'custom';
type ExportKind = 'pdf' | 'image' | 'excel';
/** The custom period. `rolling` keeps it moving (the last 7 days, always ending now); without it the dates are fixed. */
type Custom = { from: number; to: number; rolling?: number; label?: string };
const RANGES: { value: Range; label: string; title: string; ms: number }[] = [
  { value: '5m', label: 'Past 5 min', title: 'past 5 min', ms: 5 * MIN },
  { value: '10m', label: 'Past 10 min', title: 'past 10 min', ms: 10 * MIN },
  { value: '15m', label: 'Past 15 min', title: 'past 15 min', ms: 15 * MIN },
  { value: 'custom', label: 'Custom', title: 'chosen period', ms: 0 },
];
const LEVEL_COLOR: Record<Priority, string> = { P1: 'var(--q-p1)', P2: 'var(--q-p2)', P3: 'var(--q-p3)', P4: 'var(--q-p4)' };
const RECORD_COLOR: Record<QavachRecordType, string> = { Incident: 'var(--q-p1)', 'Near miss': 'var(--q-ink)', Observation: 'var(--c-blue-dark)' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (ts: number) => `${new Date(ts).getDate()} ${MONTHS[new Date(ts).getMonth()]}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const since = (ts: number, now: number) => ago(ts, now).replace(' ago', '');
const dayTimeShort = (ts: number) => `${dayName(ts)} ${hm(ts)}`;
/** Alert counts per minute (up to two hours), per hour (up to two days) or per day, oldest first. */
function buckets(list: Alert[], start: number, now: number) {
  const span = now - start;
  const step = span <= 2 * HOUR ? MIN : span <= 2 * DAY ? HOUR : DAY;
  const n = Math.max(1, Math.ceil(span / step));
  const counts = Array.from({ length: n }, (_, i) => ({ at: start + i * step, n: 0 }));
  for (const a of list) counts[Math.max(0, Math.min(n - 1, Math.floor((a.at - start) / step)))].n++;
  return { counts, unit: step === MIN ? 'minute' : step === HOUR ? 'hour' : 'day' };
}

type View = 'actions' | 'insights';
type Dialog = { kind: 'ack' | 'raise'; alert: Alert; group: string[] };

/** Two views of one terminal, for the person who has to get things done.
 *  Action Centre is what needs doing now, whatever the period: open issues (repeat detections grouped, with how long is left to
 *  respond), handled P1 and P2 alerts nobody reported to QHSE, cameras that are down and what they leave unwatched.
 *  Insights is the period, for deciding what to change: whether responses met their targets, which locations and rules
 *  produce the alerts or the false alarms, and when alerts happen. */
export function Overview() {
  const cams = useCameras();
  const alerts = useAlerts();
  const rules = useRules();
  const policies = usePolicies();
  const now = useNow(5000);
  const nav = useNavigate();
  const me = useMe();
  const confirm = useConfirm();
  // Insights is about the last few minutes: at a port, an hour is already too long to wait to know something.
  const [range, setRange] = useState<Range>('15m');
  const [custom, setCustom] = useState<Custom | undefined>();
  const [picking, setPicking] = useState(false); // whether the date and time panel is open
  const [reports, setReports] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const sheet = useRef<HTMLDivElement>(null);

  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'insights' ? 'insights' : 'actions';
  const setView = (v: View) => setParams(v === 'insights' ? { view: 'insights' } : {}, { replace: true });

  // ── The period (Insights) ──
  const base = RANGES.find((r) => r.value === range)!;
  const rolling = range === 'custom' && custom?.rolling;
  const start = rolling ? now - rolling : range === 'custom' && custom ? custom.from : now - base.ms;
  const end = rolling ? now : range === 'custom' && custom ? Math.min(now, custom.to) : now;
  const span = Math.max(1, end - start);
  const dates = custom ? (custom.label ?? `${dayTimeShort(start)} to ${dayTimeShort(end)}`) : '';
  const period = range === 'custom' && custom ? { ...base, label: dates, title: dates.toLowerCase() } : base;
  const inPeriod = range === 'custom' ? (custom?.label ? `in ${custom.label.toLowerCase()}` : `from ${dates}`) : `in the ${period.title}`;
  const inRange = alerts.filter((a) => a.at >= start && a.at <= end);
  const previous = alerts.filter((a) => a.at >= start - span && a.at < start);
  const camById = new Map(cams.map((c) => [c.id, c]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const camName = (id: string) => camById.get(id)?.name ?? '';
  // A window of up to two hours is read as "what is happening", longer ones as "how are we doing".
  const short = span <= 2 * HOUR;
  const minutes = Math.max(1, Math.round(span / MIN));

  // ── Action Centre: everything open, whenever it was raised ──
  const issues = openIssues(alerts, policies, now);
  const openAlerts = alerts.filter(isOpenAlert);
  const late = issues.filter((i) => i.overdue > 0);
  const unreported = unreportedAlerts(alerts, rules);
  const faulty = cams.filter((c) => c.status !== 'online').sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'offline' ? -1 : 1));
  const live = cams.length - faulty.length;
  const offline = faulty.filter((c) => c.status === 'offline').length;
  const degraded = faulty.length - offline;
  const blindRules = new Set(faulty.flatMap((c) => cameraImpact(c, rules, cams).blind.map((r) => r.id)));
  const noZones = cams.filter((c) => c.zones.length === 0);
  const unwatched = cams.filter((c) => !rules.some((r) => r.cameraIds.includes(c.id)));
  const testRules = rules.filter((r) => r.mode === 'test');
  const toFix = issues.length + unreported.length + faulty.length;
  const deadline = nextDeadline(issues);

  // Handled alerts of one level in the period whose rule asks for a QHSE record and that have none yet.
  const unreportedOf = (p: Priority) => unreportedAlerts(alerts, rules, start, end).filter((a) => a.priority === p);
  const sendToQhse = (list: Alert[]) =>
    confirm.ask(
      {
        title: `Send ${plural(list.length, 'alert')} to QHSE?`,
        message: 'Each gets a QHSE record drafted from its alert: the type its rule sets, where and when it happened, with the snapshot and clip. They can still be edited in QHSE.',
        action: 'Send to QHSE',
        danger: false,
      },
      () => {
        let sent = 0;
        for (const a of list) {
          const cam = camById.get(a.cameraId);
          if (!cam) continue;
          raiseInQavach(a.id, { ...draftRecord(a, cam, ruleById.get(a.ruleId), AREAS_BY_ID[cam.areaId], hm(a.at)), createdBy: me.id, source: 'manual' });
          sent++;
        }
        toast(`${plural(sent, 'alert')} reported to QHSE`);
      },
    );
  // Acknowledging an issue acknowledges every open alert in it, not just the latest.
  const closeDialog = () => {
    const d = dialog;
    setDialog(undefined);
    if (d?.kind === 'ack' && alertStore.get().find((a) => a.id === d.alert.id)?.state === 'acknowledged') {
      for (const id of d.group) if (id !== d.alert.id) acknowledge(id, me.id, 'console', 'Acknowledged with the rest of the issue');
    }
  };

  // ── Insights ──
  const levelOpen = inRange.filter(isOpenAlert);
  const sla = responseStats(inRange, policies, now);
  const slaBefore = responseStats(previous, policies, now);
  const hot = hotspots(inRange, previous, rules);
  const health = ruleHealth(inRange, rules, policies, span);
  const pattern = hourPattern(inRange);
  const handled = inRange.filter((a) => a.state === 'acknowledged' || a.state === 'resolved' || a.state === 'false-alarm');
  const falseCount = handled.filter((a) => a.state === 'false-alarm').length;
  const falsePct = pct(falseCount, handled.length);
  const handledBefore = previous.filter((a) => a.state === 'acknowledged' || a.state === 'resolved' || a.state === 'false-alarm');
  const falseBefore = pct(handledBefore.filter((a) => a.state === 'false-alarm').length, handledBefore.length);
  const falseByRule = health.filter((h) => h.falseAlarms > 0).sort((a, b) => b.falseAlarms - a.falseAlarms);
  const unreportedInPeriod = unreportedAlerts(alerts, rules, start, end);
  const raised = alerts.filter((a) => a.qavach && a.qavach.at >= start && a.qavach.at <= end);
  const byType = (['Incident', 'Near miss', 'Observation'] as QavachRecordType[]).map((t) => ({ t, n: raised.filter((a) => a.qavach!.type === t).length }));
  const reportable = raised.length + unreportedInPeriod.length;
  const normal = normalFor(alerts, end, span);
  const liveStand = liveFindings({ list: inRange, issues, normal, minutes, camName });
  const stand = findings({ list: inRange, previous, sla, hot, rulesHealth: health, unreported: unreportedInPeriod.length, pattern, spanMs: span, camName, ruleName: (id) => ruleById.get(id)?.name ?? id });
  const { counts, unit } = buckets(inRange, start, end);
  const busiest = counts.reduce((m, b) => (b.n > m.n ? b : m), counts[0]);
  const change = (n: number, was: number) => (was === 0 && n > 0 ? { text: 'No earlier data', tone: 'neutral' } : n === was ? { text: 'No change', tone: 'neutral' } : { text: `${n > was ? '▲' : '▼'} ${Math.abs(n - was)}`, tone: n > was ? 'bad' : 'good' });
  const alertsChange = change(inRange.length, previous.length);
  const slaChange = sla.pct === null || slaBefore.pct === null || sla.pct === slaBefore.pct ? { text: sla.pct === null ? 'No data' : 'No change', tone: 'neutral' } : { text: `${sla.pct > slaBefore.pct ? '▲' : '▼'} ${Math.abs(sla.pct - slaBefore.pct)} pts`, tone: sla.pct > slaBefore.pct ? 'good' : 'bad' };
  const falseChange = falsePct === null || falseBefore === null || falsePct === falseBefore ? { text: falsePct === null ? 'No data' : 'No change', tone: 'neutral' } : { text: `${falsePct > falseBefore ? '▲' : '▼'} ${Math.abs(falsePct - falseBefore)} pts`, tone: falsePct > falseBefore ? 'bad' : 'good' };
  const busiestText = busiest.n === 0 ? `No alerts ${inPeriod}` : `${unit === 'minute' ? `Busiest minute ${hm(busiest.at)}` : unit === 'hour' ? `Busiest hour ${hm(busiest.at)}` : `Busiest day ${dayName(busiest.at)}`} · ${plural(busiest.n, 'alert')}`;
  const maxHour = Math.max(1, ...pattern.counts);
  const hotMax = Math.max(1, ...hot.slice(0, 6).map((h) => h.count));
  const fileBase = `overview-${SITE.name.toLowerCase().replace(/\s+/g, '-')}-${view}-${new Date(now).toISOString().slice(0, 10)}`;

  const exportSheet = () => {
    const rows: Cell[][] = [[view === 'insights' ? 'Insights' : 'Action Centre', SITE.name], ['Exported', new Date(now).toLocaleString()]];
    if (view === 'actions') {
      rows.push(
        [],
        ['Open issues', issues.length],
        ['Past response target', late.length],
        ['Not reported to QHSE', unreported.length],
        ['Cameras to fix', faulty.length],
        [],
        ['Open issue', 'Level', 'Detections', 'Camera', 'Area', 'First seen', 'Last seen', 'Response target'],
        ...issues.map((i): Cell[] => {
          const c = camById.get(i.cameraId);
          return [i.title, i.priority, i.count, c ? `${c.id} ${c.name}` : i.cameraId, AREAS_BY_ID[c?.areaId ?? '']?.name ?? '', new Date(i.first).toLocaleString(), new Date(i.last).toLocaleString(), i.overdue > 0 ? `Overdue ${duration(i.overdue)}` : `Due in ${duration(i.left)}`];
        }),
        [],
        ['Not reported to QHSE', 'Level', 'Camera', 'Raised'],
        ...unreported.map((a): Cell[] => [a.title, a.priority, a.cameraId, new Date(a.at).toLocaleString()]),
        [],
        ['Camera to fix', 'Status', 'Down since', 'Reason'],
        ...faulty.map((c): Cell[] => [`${c.id} ${c.name}`, c.status === 'offline' ? 'Offline' : 'Degraded', new Date(unavailableSince(c)).toLocaleString(), healthReason(c)]),
      );
    } else {
      rows.push(
        ['Period', period.label],
        [],
        ['What stands out'],
        ...stand.map((f): Cell[] => [f.text]),
        [],
        ['Measure', 'Value', 'Previous period'],
        ['Alerts', inRange.length, previous.length],
        ['Acknowledged within target', sla.pct === null ? '' : `${sla.pct}%`, slaBefore.pct === null ? '' : `${slaBefore.pct}%`],
        ['False alarms (share of handled)', falsePct === null ? '' : `${falsePct}%`, falseBefore === null ? '' : `${falseBefore}%`],
        ['Reported to QHSE', raised.length],
        ['Handled P1 and P2 not reported', unreportedInPeriod.length],
        [],
        ['Location', 'Alerts', 'Previous', 'Most common'],
        ...hot.slice(0, 15).map((h): Cell[] => [`${h.cameraId} ${camName(h.cameraId)}`, h.count, h.before, h.topRule]),
        [],
        ['Rule', 'Alerts', 'False alarms', 'Average time to acknowledge', 'Note'],
        ...health.map((h): Cell[] => [h.rule.name, h.alerts, h.falsePct === null ? '' : `${h.falsePct}%`, h.avgAck === null ? '' : duration(h.avgAck), h.flag?.text ?? '']),
        [],
        ['Hour of day', 'Alerts'],
        ...pattern.counts.map((n, h): Cell[] => [`${String(h).padStart(2, '0')}:00`, n]),
      );
    }
    const width = Math.max(...rows.map((r) => r.length));
    download(writeXlsx(rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')), view === 'insights' ? 'Insights' : 'Action Centre'), `${fileBase}.xlsx`);
  };

  // A picture of the dashboard below the toolbar, at twice the screen's resolution, with a margin round it.
  const capture = async () => {
    const { toJpeg } = await import('html-to-image');
    const node = sheet.current!;
    node.classList.add('is-capturing'); // shows the title line, which says which terminal and period this is
    try {
      const w = node.offsetWidth + 48;
      const h = node.offsetHeight + 48;
      const url = await toJpeg(node, { quality: 0.95, pixelRatio: 2, backgroundColor: cssVar('--c-wash'), width: w, height: h, style: { margin: '0', padding: '24px', boxSizing: 'content-box' } });
      return { url, width: w * 2, height: h * 2 };
    } finally {
      node.classList.remove('is-capturing');
    }
  };
  const exportAs = async (kind: ExportKind) => {
    try {
      if (kind === 'excel') return exportSheet();
      const shot = await capture();
      if (kind === 'pdf') return download(jpegToPdf(dataUrlBytes(shot.url), shot.width, shot.height), `${fileBase}.pdf`);
      const a = document.createElement('a');
      a.href = shot.url;
      a.download = `${fileBase}.jpg`;
      a.click();
    } catch {
      toast('The export could not be made. Try again.', { tone: 'alert' });
    }
  };

  const issueRow = (i: Issue) => {
    const cam = camById.get(i.cameraId);
    const lateNow = i.overdue > 0;
    return (
      <li key={i.key} className="ovissue">
        <Link to={`/alerts/${i.lead.id}`} className="ovlist__item ovissue__main">
          <PriorityBadge p={i.priority} short />
          <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
            <strong className="ellipsis">
              {i.title}
              {i.count > 1 && <span className="ovissue__n" title={`${i.count} detections, last ${since(i.last, now)} ago`}>×{i.count}</span>}
            </strong>
            <span className="meta ellipsis">
              {cam?.id} · {cam?.name} · {AREAS_BY_ID[cam?.areaId ?? '']?.name}
              {i.count > 1 ? ` · since ${since(i.first, now)}` : ''}
            </span>
          </span>
          <span className={`ovsla${lateNow ? ' is-late' : ''}`} title={lateNow ? 'Past the response target for this level' : 'Time left to respond'}>
            {lateNow ? `Overdue ${since(now - i.overdue, now) === '0s' ? '' : duration(i.overdue)}` : `${duration(Math.max(0, i.left))} left`}
          </span>
        </Link>
        <button type="button" className="lvact" onClick={() => setDialog({ kind: 'ack', alert: i.lead, group: openAlerts.filter((a) => a.ruleId === i.ruleId && a.cameraId === i.cameraId).map((a) => a.id) })}>
          <Icon name="check" size={13} />
          Acknowledge
        </button>
      </li>
    );
  };

  return (
    <div className="page page--wide">
      <div className="tabs ovtabs" role="tablist" aria-label="Overview">
        <button type="button" role="tab" aria-selected={view === 'actions'} onClick={() => setView('actions')}>
          <Icon name="warning" size={17} />
          Action Centre
          <span className={`ovtabs__n${toFix ? ' is-alert' : ''}`}>{toFix}</span>
        </button>
        <button type="button" role="tab" aria-selected={view === 'insights'} onClick={() => setView('insights')}>
          <Icon name="activity" size={17} />
          Insights
        </button>
      </div>

      <div className={`ovbar${view === 'insights' && range === 'custom' ? ' ovbar--custom' : ''}`}>
        <Choice id="ov-site" label="Terminal" icon="location" className="ovbar__site" value={SITE.name} onChange={() => {}} options={[{ value: SITE.name, label: `${SITE.name} · ${cams.length} cameras` }]} />
        <span className="spacer" />
        {view === 'insights' && (
          <div className="ovperiod">
            <PillTabs
              label="Period"
              value={range}
              onChange={(r) => {
                if (r === 'custom') {
                  if (!custom) setCustom({ from: now - 15 * MIN, to: now });
                  setRange('custom');
                  setPicking(true);
                } else {
                  setPicking(false);
                  setRange(r);
                }
              }}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
            {range === 'custom' && custom && (
              <button type="button" className="dfield ovperiod__field" aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking(!picking)}>
                <span className="dfield__label">From – To</span>
                <span className="dfield__value">{custom.label ?? `${dayTimeShort(custom.from)} | ${dayTimeShort(custom.to)}`}</span>
                <span className="dfield__icons">
                  <span
                    role="button"
                    tabIndex={0}
                    className="dfield__clear"
                    aria-label="Clear the custom period"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCustom(undefined);
                      setPicking(false);
                      setRange('15m');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setCustom(undefined);
                        setPicking(false);
                        setRange('15m');
                      }
                    }}
                  >
                    <Icon name="close" size={18} stroke={2} />
                  </span>
                  <Icon name="calendar" size={26} stroke={1.5} />
                </span>
              </button>
            )}
            {picking && custom && <TimeRangePanel from={start} to={end} now={now} onChange={(c) => setCustom(c)} onClose={() => setPicking(false)} />}
          </div>
        )}
        <ExportMenu onPick={exportAs} />
        <Link to="/wall" className="btn btn--icon" title="Open Video Wall" aria-label="Open video wall">
          <Icon name="wall" size={22} />
        </Link>
      </div>

      <div ref={sheet} className="ovsheet">
        <div className="ovsheet__title">
          <strong>
            {SITE.name} · {view === 'insights' ? 'Insights' : 'Action Centre'}
          </strong>
          <span>
            {view === 'insights' ? `${period.label} · ` : ''}exported {new Date(now).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {view === 'actions' ? (
          <div className="ovgrid">
            <section className="card ovgrid__6 ovcol">
              <div className="ovcol__kpi ovcol__pair">
                <button type="button" className="ovcol__stat" onClick={() => nav('/alerts?tab=open')}>
                  <KpiHead label="Open issues" icon="warning" tone="bad" />
                  <div className="kpi__value">
                    <span className="kpi__n">{issues.length}</span>
                    {openAlerts.length > issues.length && <span className="kdelta kdelta--neutral">{openAlerts.length} alerts</span>}
                  </div>
                  <SegBar parts={LEVELS.map((p) => ({ n: issues.filter((i) => i.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                  <span className="kpi__foot">{issues.length ? `Oldest open ${since(Math.min(...issues.map((i) => i.first)), now)}` : 'Nothing open'}</span>
                </button>
                <button type="button" className="ovcol__stat" onClick={() => nav('/alerts?tab=open')}>
                  <KpiHead label="Past response target" icon="clock" tone="bad" />
                  <div className="kpi__value">
                    <span className="kpi__n">{late.length}</span>
                    {late.length > 0 && <span className="kdelta kdelta--bad">{pct(late.length, issues.length)}% of open</span>}
                  </div>
                  <SegBar parts={LEVELS.map((p) => ({ n: late.filter((i) => i.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                  <span className="kpi__foot">{late.length ? `Longest overdue ${duration(Math.max(...late.map((i) => i.overdue)))}` : 'Everything is inside its target'}</span>
                </button>
              </div>
              <div className="card__head">
                <h2>
                  Needs attention <span className="ovsub">· {plural(issues.length, 'issue')}</span>
                </h2>
                <span className="spacer" />
                <Link to="/alerts?tab=open" className="ovlink">
                  All alerts
                </Link>
              </div>
              {issues.length === 0 && <p className="card__body meta">No open alerts.</p>}
              <ul className="ovlist ovcol__list">{issues.map(issueRow)}</ul>
            </section>

            <section className="card ovgrid__3 ovcol" id="ov-unreported">
              <div className="ovcol__kpi">
                <KpiHead label="Not reported to QHSE" icon="shield" tone="neutral" />
                <div className="kpi__value">
                  <span className="kpi__n">{unreported.length}</span>
                  {unreported.length > 0 && <span className="kdelta kdelta--bad">P1 and P2</span>}
                </div>
                <SegBar parts={(['P1', 'P2'] as Priority[]).map((p) => ({ n: unreported.filter((a) => a.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                <span className="kpi__foot">{unreported.length ? 'Handled, but no QHSE record yet' : 'Every high-priority alert is reported'}</span>
                {unreported.length > 0 && (
                  <button type="button" className="btn btn--report btn--sm ovsend" onClick={() => sendToQhse(unreported)}>
                    <Icon name="send" size={15} />
                    Send all {unreported.length} to QHSE
                  </button>
                )}
              </div>
              {unreported.length === 0 && <p className="card__body meta">Nothing to report.</p>}
              <ul className="ovlist ovcol__list">
                {unreported.map((a) => {
                  const cam = camById.get(a.cameraId);
                  return (
                    <li key={a.id} className="ovissue">
                      <Link to={`/alerts/${a.id}`} className="ovlist__item ovissue__main" title="Open The Alert">
                        <PriorityBadge p={a.priority} short />
                        <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                          <strong className="ellipsis">{a.title}</strong>
                          <span className="meta ellipsis">
                            {cam?.id} · {since(a.at, now)} ago
                          </span>
                        </span>
                      </Link>
                      <button type="button" className="lvact lvact--report" onClick={() => setDialog({ kind: 'raise', alert: a, group: [a.id] })}>
                        <Icon name="send" size={13} />
                        Report
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="card ovgrid__3 ovcol">
              <div className="ovcol__kpi">
                <KpiHead label="Cameras to fix" icon="camera" tone="good" />
                <div className="kpi__value">
                  <span className="kpi__n">{faulty.length}</span>
                  <span className="kpi__of">/ {cams.length}</span>
                </div>
                <SegBar
                  parts={[
                    { n: offline, color: 'var(--q-p1)', label: 'offline' },
                    { n: degraded, color: 'var(--q-warn-dot)', label: 'degraded' },
                  ]}
                />
                <span className="kpi__foot">{faulty.length ? `${live} of ${cams.length} live${blindRules.size ? ` · ${plural(blindRules.size, 'rule')} blind` : ''}` : 'Every camera is live'}</span>
              </div>
              <div className="card__head ovcol__subhead">
                <span className="ovsub">Camera health</span>
                <span className="spacer" />
                <Link to="/cameras" className="ovlink">
                  Cameras
                </Link>
              </div>
              {faulty.length === 0 && <p className="card__body meta">Every camera is live.</p>}
              {faulty.length > 0 && (
                <div className="ovrows ovcam-headwrap" aria-hidden="true">
                  <div className="ovcam ovcam--head">
                    <span className="dot" style={{ visibility: 'hidden' }} />
                    <span className="ovcam__id">ID</span>
                    <span className="ovcam__state">Status</span>
                    <span className="ovcam__since">Since</span>
                  </div>
                </div>
              )}
              <div className="ovrows ovcol__list">
                {faulty.map((c) => {
                  const { watching } = cameraImpact(c, rules, cams);
                  return (
                    <Link key={c.id} to={`/configuration/cameras/${c.id}`} className="ovcam" title={`${healthReason(c)}${watching.length ? ` · watched by ${plural(watching.length, 'rule')}` : ''}`}>
                      <span className={`dot dot--${c.status}`} />
                      <span className="mono ovcam__id">{c.id}</span>
                      <span className="ovcam__state">{c.status === 'offline' ? 'Offline' : 'Degraded'}</span>
                      <span className="ovcam__since" title={`Unavailable since ${hm(unavailableSince(c))}`}>
                        {since(unavailableSince(c), now)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>

            <section className="card ovgrid__12">
              <div className="card__head">
                <h2>Coverage gaps</h2>
                <span className="ovsub">· what the cameras cannot catch yet</span>
              </div>
              <div className="ovgaps">
                <GapList title="No zones drawn" hint="Detection only runs inside zones" all="/cameras?coverage=no-zones" items={noZones.map((c) => ({ id: c.id, text: c.name, to: `/configuration/cameras/${c.id}` }))} />
                <GapList title="Not watched by any rule" hint="No rule raises alerts from these" all="/cameras?coverage=no-rules" items={unwatched.map((c) => ({ id: c.id, text: c.name, to: `/configuration/cameras/${c.id}` }))} />
                <GapList title="Rules still in test" hint="Matches are logged, no one is told" all="/rules?tab=test" items={testRules.map((r) => ({ id: r.id, text: r.name, to: `/configuration/rules/${r.id}` }))} />
              </div>
            </section>
          </div>
        ) : short ? (
          <>
            {liveStand.length > 0 && (
              <section className="card ovfind">
                <div className="card__head">
                  <h2>What stands out</h2>
                  <span className="ovsub">· {period.label}</span>
                </div>
                <ul className="ovfind__list">
                  {liveStand.map((f, i) => (
                    <li key={i} className={`ovfind__item ovfind__item--${f.tone}`}>
                      <Icon name={f.tone === 'info' ? 'info' : 'warning'} size={18} />
                      <span className="ovfind__text">{f.text}</span>
                      <Link to={f.to} className="lvact">
                        {f.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="kpis">
              <div className="kpi">
                <KpiHead label={`Alerts, ${period.title}`} icon="bell" tone="info" />
                <div className="kpi__value">
                  <span className="kpi__n">{inRange.length}</span>
                  {normal.days >= 3 && normal.total > 0 ? (
                    <span className={`kdelta kdelta--${inRange.length >= 2 * normal.total && inRange.length >= 2 ? 'bad' : 'neutral'}`}>{(inRange.length / normal.total).toFixed(1)}× usual</span>
                  ) : (
                    <span className={`kdelta kdelta--${alertsChange.tone}`}>{alertsChange.text}</span>
                  )}
                </div>
                <Spark values={counts.map((c) => c.n)} />
                <span className="kpi__foot">{normal.days >= 3 ? `Usually ${normal.total.toFixed(1)} at this time of day` : busiestText}</span>
              </div>

              <button type="button" className="kpi" onClick={() => nav('/')}>
                <KpiHead label="Waiting for a response" icon="clock" tone="bad" />
                <div className="kpi__value">
                  <span className="kpi__n">{issues.length}</span>
                  {late.length > 0 && <span className="kdelta kdelta--bad">{late.length} past target</span>}
                </div>
                <SegBar parts={LEVELS.map((p) => ({ n: issues.filter((i) => i.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                <span className="kpi__foot">{issues.length ? (() => { const o = issues.reduce((a, b) => (b.first < a.first ? b : a)); return `Oldest ${since(o.first, now)} · ${o.cameraId} ${camName(o.cameraId)}`; })() : 'Nothing is waiting'}</span>
              </button>

              <Link to={deadline ? `/alerts/${deadline.lead.id}` : '/'} className="kpi">
                <KpiHead label="Next deadline" icon="clock" tone={deadline ? 'info' : 'good'} />
                <div className="kpi__value">
                  {deadline ? (
                    <>
                      <span className="kpi__n kpi__n--text">{duration(deadline.left)}</span>
                      <PriorityBadge p={deadline.priority} short />
                    </>
                  ) : late.length ? (
                    <>
                      <span className="kpi__n kpi__n--text is-late">Overdue</span>
                      <span className="kdelta kdelta--bad">{plural(late.length, 'issue')}</span>
                    </>
                  ) : (
                    <span className="kpi__n kpi__n--text">–</span>
                  )}
                </div>
                <span className="kpi__foot ovdl__foot">
                  {deadline ? `Response target for ${deadline.title} on ${deadline.cameraId}: ${Math.round((deadline.left + now - deadline.first) / 60000)} min` : late.length ? 'Everything open is already past its target' : 'Nothing is waiting on a response'}
                </span>
              </Link>

              <Link to={hot[0] ? `/alerts?camera=${encodeURIComponent(hot[0].cameraId)}` : '/alerts'} className="kpi">
                <KpiHead label="Busiest spot" icon="location" tone="neutral" />
                <div className="kpi__value">
                  <span className="kpi__n kpi__n--text">{hot[0]?.cameraId ?? '–'}</span>
                  {hot[0] && <span className="kdelta kdelta--neutral">{plural(hot[0].count, 'alert')}</span>}
                </div>
                <span className="kpi__foot ellipsis">{hot[0] ? `${camName(hot[0].cameraId)} · ${AREAS_BY_ID[camById.get(hot[0].cameraId)?.areaId ?? '']?.name ?? ''}` : `No alerts ${inPeriod}`}</span>
              </Link>
            </div>

            <div className="ovgrid">
              <section className="card ovgrid__12">
                <div className="card__head">
                  <h2>What happened</h2>
                  <span className="ovsub">· {period.label}, newest first</span>
                  <span className="spacer" />
                  <Link to="/alerts" className="ovlink">
                    All alerts
                  </Link>
                </div>
                {inRange.length === 0 && <p className="card__body meta">No alerts {inPeriod}.</p>}
                <ul className="ovfeed">
                  {[...inRange]
                    .sort((a, b) => b.at - a.at)
                    .slice(0, 12)
                    .map((a) => {
                      const cam = camById.get(a.cameraId);
                      const target = (policies.find((p) => p.priority === a.priority)?.ackWithinMin ?? 15) * MIN;
                      const answered = a.ackAt ? a.ackAt - a.at : null;
                      const waiting = isOpenAlert(a) ? now - a.at : null;
                      const lateRow = (answered ?? waiting ?? 0) > target;
                      return (
                        <li key={a.id}>
                          <Link to={`/alerts/${a.id}`} className="ovfeed__row">
                            <span className="ovfeed__time">{hm(a.at)}</span>
                            <PriorityBadge p={a.priority} short />
                            <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                              <strong className="ellipsis">
                                {a.title}
                                {(a.repeats ?? 0) > 0 && <span className="ovissue__n">×{1 + (a.repeats ?? 0)}</span>}
                              </strong>
                              <span className="meta ellipsis">
                                {cam?.id} · {cam?.name} · {AREAS_BY_ID[cam?.areaId ?? '']?.name}
                              </span>
                            </span>
                            <span className={`ovfeed__resp${lateRow ? ' is-late' : ''}`}>
                              {answered !== null ? `Acknowledged in ${duration(answered)}` : waiting !== null ? `Waiting ${duration(waiting)}` : ''}
                            </span>
                            <StateChip state={a.state} />
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </section>

              <section className="card ovgrid__6">
                <div className="card__head">
                  <h2>Against a normal day</h2>
                  <span className="ovsub">· same {minutes} min on the last {normal.days || 0} days</span>
                </div>
                <ul className="ovnorm">
                  {LEVELS.map((p) => {
                    const now1 = inRange.filter((a) => a.priority === p).length;
                    const usual = normal.byLevel.find((x) => x.p === p)?.n ?? 0;
                    const top = Math.max(1, now1, usual);
                    return (
                      <li key={p} className="ovnorm__row">
                        <PriorityBadge p={p} short />
                        <span className="ovnorm__bars">
                          <i className="ovnorm__now" style={{ width: `${(now1 / top) * 100}%`, background: LEVEL_COLOR[p] }} />
                          <i className="ovnorm__usual" style={{ width: `${(usual / top) * 100}%` }} />
                        </span>
                        <span className="ovnorm__n">
                          <b>{now1}</b> now · usual {usual.toFixed(1)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="meta ovhours__note">Coloured bar: now. Grey bar: what this time of day usually has.</p>
              </section>

              <section className="card ovgrid__6">
                <div className="card__head">
                  <h2>Who knows, and what to do</h2>
                  <span className="ovsub">· open issues, most urgent first</span>
                </div>
                {issues.length === 0 && <p className="card__body meta">Nothing is open.</p>}
                <ul className="ovwho">
                  {issues.slice(0, 4).map((i) => {
                    const told = peopleTold(i.lead);
                    const cam = camById.get(i.cameraId);
                    const suggest = cam ? draftRecord(i.lead, cam, ruleById.get(i.ruleId), AREAS_BY_ID[cam.areaId], hm(i.lead.at)).immediateAction : '';
                    const nobodyRead = told.length > 0 && !told.some((t) => t.status === 'read');
                    return (
                      <li key={i.key} className="ovwho__item">
                        <div className="ovwho__head">
                          <PriorityBadge p={i.priority} short />
                          <Link to={`/alerts/${i.lead.id}`} className="ovwho__title ellipsis">
                            {i.title} · {i.cameraId}
                          </Link>
                          <span className={`ovsla${i.overdue > 0 ? ' is-late' : ''}`}>{i.overdue > 0 ? `Overdue ${duration(i.overdue)}` : `${duration(Math.max(0, i.left))} left`}</span>
                        </div>
                        <div className="ovwho__told">
                          {told.length === 0 ? (
                            <span className="ovwho__warn">No one has been notified</span>
                          ) : (
                            told.map((t) => (
                              <span key={t.to} className={`ovwho__person ovwho__person--${t.status}`} title={`${[...t.channels].join(', ')}${t.escalation ? ' · escalation' : ''}`}>
                                {t.escalation ? 'Escalated to ' : ''}
                                {userName(t.to)}
                                <i>{t.status === 'read' ? 'read' : t.status === 'delivered' ? 'not read' : t.status === 'sent' ? 'calling' : 'not reached'}</i>
                              </span>
                            ))
                          )}
                          {nobodyRead && <span className="ovwho__warn">No one has read it yet</span>}
                        </div>
                        {suggest && (
                          <div className="ovwho__do">
                            <Icon name="arrow-right" size={14} />
                            <span>{suggest}</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </>
        ) : (
          <>
            {stand.length > 0 && (
              <section className="card ovfind">
                <div className="card__head">
                  <h2>What stands out</h2>
                  <span className="ovsub">· {period.label}</span>
                </div>
                <ul className="ovfind__list">
                  {stand.map((f, i) => (
                    <li key={i} className={`ovfind__item ovfind__item--${f.tone}`}>
                      <Icon name={f.tone === 'info' ? 'info' : 'warning'} size={18} />
                      <span className="ovfind__text">{f.text}</span>
                      <Link to={f.to} className="lvact">
                        {f.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="kpis">
              <div className="kpi">
                <KpiHead label="Acknowledged within target" icon="clock" tone="info" />
                <div className="kpi__value">
                  <span className="kpi__n">{sla.pct === null ? '–' : `${sla.pct}%`}</span>
                  <span className={`kdelta kdelta--${slaChange.tone}`}>{slaChange.text}</span>
                </div>
                <SegBar parts={[{ n: sla.met, color: 'var(--c-green)', label: 'on time' }, { n: sla.missed, color: 'var(--q-p1)', label: 'late or missed' }]} />
                <span className="kpi__foot">{sla.missed ? `${plural(sla.missed, 'alert')} missed their target` : 'Every alert was answered in time'}</span>
              </div>

              <div className="kpi">
                <KpiHead label="Alerts" icon="bell" tone="info" />
                <div className="kpi__value">
                  <span className="kpi__n">{inRange.length}</span>
                  <span className={`kdelta kdelta--${alertsChange.tone}`}>{alertsChange.text}</span>
                </div>
                <Spark values={counts.map((c) => c.n)} />
                <span className="kpi__foot">{busiestText}</span>
              </div>

              <div className="kpi">
                <KpiHead label="False alarms" icon="check" tone="good" />
                <div className="kpi__value">
                  <span className="kpi__n">{falsePct === null ? '–' : `${falsePct}%`}</span>
                  <span className={`kdelta kdelta--${falseChange.tone}`}>{falseChange.text}</span>
                </div>
                <SegBar parts={[{ n: handled.length - falseCount, color: 'var(--c-green)', label: 'real' }, { n: falseCount, color: 'var(--q-p2)', label: 'false' }]} />
                <span className="kpi__foot">{falseByRule[0] ? `Most from ${falseByRule[0].rule.name.toLowerCase()} (${falseByRule[0].falseAlarms})` : 'Of handled alerts'}</span>
              </div>

              <button type="button" className="kpi" onClick={() => (unreportedInPeriod.length ? nav('/') : setReports(true))}>
                <KpiHead label="Reported to QHSE" icon="shield" tone="neutral" />
                <div className="kpi__value">
                  <span className="kpi__n">{raised.length}</span>
                  <span className={`kdelta kdelta--${unreportedInPeriod.length ? 'bad' : 'neutral'}`}>{unreportedInPeriod.length ? `${unreportedInPeriod.length} still to report` : reportable ? 'All reported' : 'None'}</span>
                </div>
                <SegBar parts={byType.map((b) => ({ n: b.n, color: RECORD_COLOR[b.t], label: b.t.toLowerCase() }))} />
                <span className="kpi__foot">{unreportedInPeriod.length ? 'Open the Action Centre to report them' : `From alerts ${inPeriod}`}</span>
              </button>
            </div>

            <div className="ovgrid">
              <section className="card ovgrid__12">
                <div className="card__head">
                  <h2>Alerts by level</h2>
                  <span className="ovsub">· over time</span>
                  <span className="spacer" />
                  <span className="ovmeta">{period.label}</span>
                </div>
                <LevelChart list={inRange} openList={levelOpen} start={start} end={end} unreportedOf={unreportedOf} onSend={sendToQhse} />
              </section>

              <section className="card ovgrid__6">
                <div className="card__head">
                  <h2>Where to look</h2>
                  <span className="ovsub">· locations with the most alerts</span>
                </div>
                {hot.length === 0 && <p className="card__body meta">No alerts {inPeriod}.</p>}
                <ul className="ovhot">
                  {hot.slice(0, 6).map((h) => {
                    const cam = camById.get(h.cameraId);
                    const trend = h.count - h.before;
                    return (
                      <li key={h.cameraId}>
                        <Link to={`/alerts?camera=${encodeURIComponent(h.cameraId)}`} className="ovhot__row" title="See The Alerts From This Camera">
                          <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                            <strong className="ellipsis">
                              <span className="mono">{h.cameraId}</span> {cam?.name}
                            </strong>
                            <span className="meta ellipsis">
                              {AREAS_BY_ID[cam?.areaId ?? '']?.name} · mostly {h.topRule.toLowerCase()}
                            </span>
                          </span>
                          <span className="ovtrack">
                            <i style={{ width: `${(h.count / hotMax) * 100}%` }} />
                          </span>
                          <b className="ovnum">{h.count}</b>
                          <span className={`ovhot__trend${trend > 0 ? ' is-up' : trend < 0 ? ' is-down' : ''}`}>{trend === 0 ? '–' : `${trend > 0 ? '▲' : '▼'} ${Math.abs(trend)}`}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="card ovgrid__6">
                <div className="card__head">
                  <h2>Rules</h2>
                  <span className="ovsub">· which ones to tune</span>
                  <span className="spacer" />
                  <Link to="/rules" className="ovlink">
                    All rules
                  </Link>
                </div>
                {health.length === 0 && <p className="card__body meta">No rule raised an alert {inPeriod}.</p>}
                <div className="ovrulehead" aria-hidden="true">
                  <span>Rule</span>
                  <span>Alerts</span>
                  <span>False</span>
                  <span>Avg ack</span>
                </div>
                <ul className="ovrules">
                  {health.slice(0, 8).map((h) => (
                    <li key={h.rule.id}>
                      <Link to={`/configuration/rules/${h.rule.id}`} className="ovrule" title={h.flag ? `${h.flag.text}: open the rule` : 'Open The Rule'}>
                        <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                          <strong className="ellipsis">{h.rule.name}</strong>
                          {h.flag && <span className={`ovrule__flag ovrule__flag--${h.flag.kind}`}>{h.flag.text}</span>}
                        </span>
                        <span className="ovrule__n">{h.alerts}</span>
                        <span className={`ovrule__n${h.flag?.kind === 'noisy' ? ' is-bad' : ''}`}>{h.falsePct === null ? '–' : `${h.falsePct}%`}</span>
                        <span className="ovrule__n">{h.avgAck === null ? '–' : duration(h.avgAck)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card ovgrid__12">
                <div className="card__head">
                  <h2>When alerts happen</h2>
                  <span className="ovsub">· by hour of the day</span>
                  <span className="spacer" />
                  <span className="ovmeta">
                    Day shift 06–18: {pattern.day} · Night shift 18–06: {pattern.night}
                  </span>
                </div>
                <div className="ovhours">
                  {pattern.counts.map((n, h) => (
                    <div key={h} className={`ovhours__col${h >= 6 && h < 18 ? ' is-day' : ''}${n === Math.max(...pattern.counts) && n > 0 ? ' is-peak' : ''}`} title={`${String(h).padStart(2, '0')}:00 · ${plural(n, 'alert')}`}>
                      <i style={{ height: `${Math.max(n ? 4 : 0, (n / maxHour) * 100)}%` }} />
                      <span>{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
                    </div>
                  ))}
                </div>
                <p className="meta ovhours__note">
                  {inRange.length === 0
                    ? `No alerts ${inPeriod}.`
                    : span < 2 * DAY
                      ? 'A single day is too little to see a pattern. Pick a week or more.'
                      : `Busiest hour ${String(pattern.peak).padStart(2, '0')}:00, about ${pattern.peakTimes.toFixed(1)} times the average hour.`}
                </p>
              </section>
            </div>
          </>
        )}
      </div>

      {dialog?.kind === 'ack' && <AckDialog alert={dialog.alert} via="console" onClose={closeDialog} />}
      {dialog?.kind === 'raise' && <RaiseDialog alert={dialog.alert} onClose={closeDialog} />}
      {confirm.dialog}
      {reports && <QavachReportsDrawer onClose={() => setReports(false)} />}
    </div>
  );
}

/** Alerts by level for the period. Each level card says how many, how many are still open or escalated and how fast they
 *  were acknowledged, then offers the next step: review the open ones, or send the handled ones that have no QHSE record.
 *  Clicking a card's count hides or shows that level in the timeline. Under the cards, a compact stacked timeline (one bar
 *  per minute, hour or day); point at a bar for its counts. */
function LevelChart({ list, openList, start, end, unreportedOf, onSend }: { list: Alert[]; openList: Alert[]; start: number; end: number; unreportedOf: (p: Priority) => Alert[]; onSend: (list: Alert[]) => void }) {
  const [hidden, setHidden] = useState<Priority[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const span = Math.max(1, end - start);
  const step = span <= 2 * HOUR ? MIN : span <= 2 * DAY ? HOUR : DAY;
  const n = Math.max(1, Math.ceil(span / step));
  const cols = Array.from({ length: n }, (_, i) => ({ at: start + i * step, by: { P1: 0, P2: 0, P3: 0, P4: 0 } as Record<Priority, number> }));
  for (const a of list) cols[Math.max(0, Math.min(n - 1, Math.floor((a.at - start) / step)))].by[a.priority]++;
  const shown = LEVELS.filter((p) => !hidden.includes(p));
  const totalOf = (c: (typeof cols)[number]) => shown.reduce((sum, p) => sum + c.by[p], 0);
  const max = Math.max(1, ...cols.map(totalOf));
  const label = (ts: number) => (step === DAY ? dayName(ts) : hm(ts));
  const ticks = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1].filter((v, i, arr) => arr.indexOf(v) === i);
  const toggle = (p: Priority) => setHidden((h) => (h.includes(p) ? h.filter((x) => x !== p) : h.length === LEVELS.length - 1 ? h : [...h, p]));
  const h = hover === null ? null : cols[hover];
  return (
    <div className="lvchart">
      <div className="lvchart__levels">
        {LEVELS.map((p) => {
          const of = list.filter((a) => a.priority === p);
          const open = openList.filter((a) => a.priority === p);
          const esc = open.filter((a) => a.state === 'escalated').length;
          const ack = mean(of.filter((a) => a.ackAt && a.ackAt >= a.at).map((a) => a.ackAt! - a.at));
          const unrep = unreportedOf(p);
          const off = hidden.includes(p);
          return (
            <div key={p} className={`lvlevel${off ? ' is-off' : ''}`} style={{ borderTopColor: LEVEL_COLOR[p] }}>
              <button type="button" className="lvlevel__top" aria-pressed={!off} onClick={() => toggle(p)} title={off ? `Show ${p} In The Timeline` : `Hide ${p} From The Timeline`}>
                <PriorityBadge p={p} />
                <b className="lvlevel__n">{of.length}</b>
                <span className="lvlevel__share">{pct(of.length, list.length) ?? 0}%</span>
              </button>
              <span className="lvlevel__meta">
                <span className={open.length ? 'is-bad' : ''}>{open.length} open</span>
                {esc > 0 && <span className="is-bad"> · {esc} escalated</span>}
                {ack !== null && <span> · ack {duration(ack)}</span>}
              </span>
              <span className="lvlevel__acts">
                {open.length > 0 && (
                  <Link to={`/alerts?level=${p}&tab=open`} className="lvact">
                    Review {open.length} open
                  </Link>
                )}
                {unrep.length > 0 && (
                  <button type="button" className="lvact lvact--report" onClick={() => onSend(unrep)}>
                    <Icon name="send" size={13} />
                    Send {unrep.length} to QHSE
                  </button>
                )}
                {open.length === 0 && unrep.length === 0 && <span className="lvact lvact--clear">Nothing to do</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="lvchart__plot" onMouseLeave={() => setHover(null)}>
        <div className="lvchart__axis" aria-hidden="true">
          <span>{max}</span>
          <span>0</span>
        </div>
        <div className="lvchart__bars">
          <i className="lvchart__grid" style={{ bottom: '100%' }} />
          {cols.map((c, i) => (
            <div key={c.at} className={`lvchart__col${hover === i ? ' is-hover' : ''}`} onMouseEnter={() => setHover(i)} aria-label={`${label(c.at)}: ${totalOf(c)} alerts`}>
              {shown.map((p) => (c.by[p] ? <span key={p} style={{ height: `${(c.by[p] / max) * 100}%`, background: LEVEL_COLOR[p] }} /> : null))}
            </div>
          ))}
          {h && hover !== null && (
            <div className="lvchart__tip" style={{ left: `${((hover + 0.5) / n) * 100}%`, transform: hover < n / 2 ? 'translateX(14px)' : 'translateX(calc(-100% - 14px))' }}>
              <strong>{step === DAY ? dayName(h.at) : `${hm(h.at)}–${hm(h.at + step)}`}</strong>
              {shown.map((p) => (
                <span key={p}>
                  <i style={{ background: LEVEL_COLOR[p] }} />
                  {p} <b>{h.by[p]}</b>
                </span>
              ))}
              <span className="lvchart__tipsum">
                Total <b>{totalOf(h)}</b>
              </span>
            </div>
          )}
        </div>
        <div className="lvchart__x" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${((t + 0.5) / n) * 100}%` }}>
              {label(cols[t].at)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The custom period: an exact start and end, each a date and a time. Changes apply as they are made. */
function TimeRangePanel({ from, to, now, onChange, onClose }: { from: number; to: number; now: number; onChange: (c: Custom) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('.ovperiod__field')) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const read = (v: string) => new Date(v).getTime();
  return (
    <div className="ovrange" ref={ref} role="dialog" aria-label="Custom period">
      <label className="field">
        <span className="field__label">From</span>
        <input
          type="datetime-local"
          className="input"
          value={local(from)}
          max={local(Math.min(to, now))}
          onChange={(e) => {
            const v = read(e.target.value);
            if (!Number.isNaN(v)) onChange({ from: Math.min(v, to), to });
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">To</span>
        <input
          type="datetime-local"
          className="input"
          value={local(to)}
          min={local(from)}
          max={local(now)}
          onChange={(e) => {
            const v = read(e.target.value);
            if (!Number.isNaN(v)) onChange({ from, to: Math.max(from, Math.min(v, now)) });
          }}
        />
      </label>
      <button type="button" className="btn btn--sm" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/** One kind of coverage gap: a count, what it means, and the first few items with a link to fix each. */
function GapList({ title, hint, items, all }: { title: string; hint: string; items: { id: string; text: string; to: string }[]; all: string }) {
  return (
    <div className="ovgap">
      <div className="ovgap__head">
        <b className={`ovgap__n${items.length ? ' is-alert' : ''}`}>{items.length}</b>
        <span className="stack" style={{ gap: 0 }}>
          <strong>{title}</strong>
          <span className="meta">{hint}</span>
        </span>
      </div>
      {items.length === 0 ? (
        <p className="meta ovgap__none">None</p>
      ) : (
        <ul className="ovgap__list">
          {items.slice(0, 5).map((it) => (
            <li key={it.id}>
              <Link to={it.to}>
                <span className="mono">{it.id}</span> <span className="ellipsis">{it.text}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link to={all} className="ovgap__more" title="See The Full List, Already Filtered">
              View all {items.length}
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}

function KpiHead({ label, icon, tone }: { label: string; icon: IconName; tone: 'bad' | 'info' | 'good' | 'neutral' }) {
  return (
    <div className="kpi__head">
      <span className="kpi__label">{label}</span>
      <span className={`kpi__icon kpi__icon--${tone}`}>
        <Icon name={icon} size={16} />
      </span>
    </div>
  );
}

/** One bar split by share, with its legend underneath. */
function SegBar({ parts }: { parts: { n: number; color: string; label: string }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  return (
    <div className="kviz">
      <div className="segbar">
        {total === 0 ? <span style={{ flex: 1, background: 'var(--c-light)' }} /> : parts.filter((p) => p.n > 0).map((p) => <span key={p.label} style={{ flex: p.n, background: p.color }} title={`${p.n} ${p.label}`} />)}
      </div>
      <div className="seglg">
        {parts.map((p) => (
          <span key={p.label}>
            <i style={{ background: p.color }} />
            {p.n} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A small area line of the alert counts over the period. */
function Spark({ values }: { values: number[] }) {
  const w = 300;
  const h = 34;
  const max = Math.max(1, ...values);
  const vals = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - (v / max) * (h - 6)]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <div className="kviz">
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={`0,${h} ${line} ${w},${h}`} fill="color-mix(in srgb, var(--c-blue-dark) 14%, transparent)" />
        <polyline points={line} fill="none" stroke="var(--c-blue-dark)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/** EXPORT opens a small menu in the logout menu's style: PDF, image or Excel sheet. */
function ExportMenu({ onPick }: { onPick: (kind: ExportKind) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const pick = async (kind: ExportKind) => {
    setOpen(false);
    setBusy(true);
    await onPick(kind);
    setBusy(false);
  };
  return (
    <div className="ovexport" ref={ref}>
      <button type="button" className="btn btn--secondary btn--icon" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)} title={busy ? 'Exporting…' : 'Export'} aria-label={busy ? 'Exporting' : 'Export'}>
        <Icon name="download" size={22} />
      </button>
      {open && (
        <div className="ovexport__menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick('pdf')}>
            <Icon name="doc" size={18} />
            PDF
          </button>
          <button type="button" role="menuitem" onClick={() => pick('image')}>
            <Icon name="grid" size={18} />
            Image
          </button>
          <button type="button" role="menuitem" onClick={() => pick('excel')}>
            <Icon name="list" size={18} />
            Excel sheet
          </button>
        </div>
      )}
    </div>
  );
}
