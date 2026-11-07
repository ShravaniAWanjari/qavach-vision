import { useEffect, useRef, useState } from 'react';
import { cssVar } from '../styles/colors';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Icon, type IconName } from '../components/Icon';
import { QavachReportsDrawer } from '../components/QavachReports';
import { Choice, PillTabs, PriorityBadge, StateChip, useConfirm } from '../components/ui';
import { AREAS, SITE } from '../data/seed';
import type { Alert, Priority, QavachRecordType } from '../data/types';
import { healthReason } from '../lib/health';
import { dataUrlBytes, jpegToPdf } from '../lib/pdf';
import { download, writeXlsx, type Cell } from '../lib/sheet';
import { ago, duration, hm, useNow } from '../lib/time';
import { draftRecord } from '../lib/qai';
import { AREAS_BY_ID, isOpen, raiseInQavach, toast, unavailableSince, useAlerts, useCameras, useMe, useRules } from '../state/store';
import './overview.css';

type Range = '5m' | '10m' | '15m' | 'custom';
type ExportKind = 'pdf' | 'image' | 'excel';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN = 60000;
const RANGES: { value: Range; label: string; title: string; ms: number }[] = [
  { value: '5m', label: 'Past 5 min', title: 'past 5 min', ms: 5 * MIN },
  { value: '10m', label: 'Past 10 min', title: 'past 10 min', ms: 10 * MIN },
  { value: '15m', label: 'Past 15 min', title: 'past 15 min', ms: 15 * MIN },
  { value: 'custom', label: 'Custom', title: 'chosen period', ms: 0 },
];
const LEVELS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const LEVEL_COLOR: Record<Priority, string> = { P1: 'var(--q-p1)', P2: 'var(--q-p2)', P3: 'var(--q-p3)', P4: 'var(--q-p4)' };
const RECORD_COLOR: Record<QavachRecordType, string> = { Incident: 'var(--q-p1)', 'Near miss': 'var(--q-ink)', Observation: 'var(--c-blue-dark)' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (ts: number) => `${new Date(ts).getDate()} ${MONTHS[new Date(ts).getMonth()]}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const since = (ts: number, now: number) => ago(ts, now).replace(' ago', '');

/** When the period starts: a few minutes back, or the chosen date and time. */
function rangeStart(r: Range, now: number, custom?: { from: number; to: number }): number {
  if (r === 'custom' && custom) return custom.from;
  return now - (RANGES.find((x) => x.value === r)?.ms ?? 15 * MIN);
}

/** Alert counts per minute (up to two hours), per hour (up to two days) or per day, oldest first. */
function buckets(list: Alert[], start: number, now: number) {
  const span = now - start;
  const step = span <= 2 * HOUR ? MIN : span <= 2 * DAY ? HOUR : DAY;
  const n = Math.max(1, Math.ceil(span / step));
  const counts = Array.from({ length: n }, (_, i) => ({ at: start + i * step, n: 0 }));
  for (const a of list) counts[Math.max(0, Math.min(n - 1, Math.floor((a.at - start) / step)))].n++;
  return { counts, unit: step === MIN ? 'minute' : step === HOUR ? 'hour' : 'day' };
}

/** "7 Nov 10:30" */
const dayTimeShort = (ts: number) => `${dayName(ts)} ${hm(ts)}`;

type View = 'actions' | 'insights';
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);

/** Two views of one terminal. Action Centre is now: what is open, what was handled but never reported to QHSE, which
 *  cameras are broken and what the cameras cannot see. Insights is the period: how many alerts, how fast they were
 *  acknowledged, how many were false, what was reported, and where and what the hazards were. */
export function Overview() {
  const cams = useCameras();
  const alerts = useAlerts();
  const rules = useRules();
  const now = useNow(5000);
  const nav = useNavigate();
  const me = useMe();
  const confirm = useConfirm();
  const [range, setRange] = useState<Range>('15m');
  const [custom, setCustom] = useState<{ from: number; to: number }>();
  const [picking, setPicking] = useState(false); // whether the date and time panel is open
  const [reports, setReports] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  const dates = custom ? `${dayTimeShort(custom.from)} to ${dayTimeShort(custom.to)}` : '';
  const base = RANGES.find((r) => r.value === range)!;
  const period = range === 'custom' && custom ? { ...base, label: dates, title: dates } : base;
  const inPeriod = range === 'custom' ? `from ${dates}` : `in the ${period.title}`;
  const start = rangeStart(range, now, custom);
  const end = range === 'custom' && custom ? Math.min(now, custom.to) : now;
  const span = end - start;
  const inRange = alerts.filter((a) => a.at >= start && a.at <= end);
  const before = alerts.filter((a) => a.at >= start - span && a.at < start).length;
  const camById = new Map(cams.map((c) => [c.id, c]));
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'insights' ? 'insights' : 'actions';
  const setView = (v: View) => setParams(v === 'insights' ? { view: 'insights' } : {}, { replace: true });
  // Action Centre shows everything that needs doing, whenever it was raised; Insights follows the chosen period.
  const openAll = alerts.filter(isOpen).sort((a, b) => (a.priority === b.priority ? b.at - a.at : a.priority.localeCompare(b.priority)));
  const open = view === 'actions' ? openAll : openAll.filter((a) => a.at >= start && a.at <= end);
  const escalated = open.filter((a) => a.state === 'escalated').length;
  const oldest = open.reduce((m, a) => Math.min(m, a.at), now);
  const { counts, unit } = buckets(inRange, start, end);
  const busiest = counts.reduce((m, b) => (b.n > m.n ? b : m), counts[0]);

  const live = cams.filter((c) => c.status === 'online').length;
  const degraded = cams.filter((c) => c.status === 'degraded').length;
  const offline = cams.filter((c) => c.status === 'offline').length;
  const faulty = cams.filter((c) => c.status !== 'online').sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'offline' ? -1 : 1));

  const raised = alerts.filter((a) => a.qavach && a.qavach.at >= start && a.qavach.at <= end);
  const raisedBefore = alerts.filter((a) => a.qavach && a.qavach.at >= start - span && a.qavach.at < start).length;
  const byType = (['Incident', 'Near miss', 'Observation'] as QavachRecordType[]).map((t) => ({ t, n: raised.filter((a) => a.qavach!.type === t).length }));

  const byArea = AREAS.map((a) => ({
    a,
    n: inRange.filter((x) => camById.get(x.cameraId)?.areaId === a.id).length,
    open: open.filter((x) => camById.get(x.cameraId)?.areaId === a.id).length,
  })).sort((x, y) => y.n - x.n || y.open - x.open);
  const areaMax = Math.max(1, ...byArea.map((x) => x.n));

  const hazardCount = new Map<string, number>();
  for (const a of inRange) {
    const name = rules.find((r) => r.id === a.ruleId)?.name ?? a.title;
    hazardCount.set(name, (hazardCount.get(name) ?? 0) + 1);
  }
  const hazards = [...hazardCount.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const hazardMax = Math.max(1, ...hazards.map((h) => h.n));


  // Action Centre
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const escalatedList = open.filter((a) => a.state === 'escalated');
  const oldestEscalated = escalatedList.reduce((m, a) => Math.min(m, a.at), now);
  // Handled (acknowledged or resolved) P1 and P2 alerts whose rule asks for a QHSE record, but none was raised.
  const unreported = alerts
    .filter((a) => (a.priority === 'P1' || a.priority === 'P2') && !a.qavach && (a.state === 'acknowledged' || a.state === 'resolved') && (ruleById.get(a.ruleId)?.qavach ?? 'none') !== 'none')
    .sort((a, b) => a.priority.localeCompare(b.priority) || b.at - a.at);
  // Handled alerts of one level, in the period, whose rule asks for a QHSE record and that have none yet.
  const unreportedOf = (p: Priority) =>
    alerts.filter((a) => a.priority === p && a.at >= start && a.at <= end && !a.qavach && (a.state === 'acknowledged' || a.state === 'resolved') && (ruleById.get(a.ruleId)?.qavach ?? 'none') !== 'none');
  // Sends a batch to QHSE, each with the record drafted from its own alert (type from its rule, snapshot and clip attached).
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
  const noZones = cams.filter((c) => c.status !== 'offline' && c.zones.length === 0);
  const unwatched = cams.filter((c) => !rules.some((r) => r.cameraIds.includes(c.id)));
  const testRules = rules.filter((r) => r.mode === 'test');
  const toFix = openAll.length + unreported.length + faulty.length;

  // Insights
  const ackTimes = (list: Alert[]) => list.filter((a) => a.ackAt && a.ackAt >= a.at).map((a) => a.ackAt! - a.at);
  const beforeList = alerts.filter((a) => a.at >= start - span && a.at < start);
  const mtta = mean(ackTimes(inRange));
  const mttaBefore = mean(ackTimes(beforeList));
  const closedIn = (list: Alert[]) => list.filter((a) => a.state !== 'new' && a.state !== 'escalated');
  const falseRate = pct(inRange.filter((a) => a.state === 'false-alarm').length, closedIn(inRange).length);
  const falseBefore = pct(beforeList.filter((a) => a.state === 'false-alarm').length, closedIn(beforeList).length);
  const escRate = pct(inRange.filter((a) => a.escalatedTo || a.state === 'escalated').length, inRange.length);
  const lowerIsBetter = (n: number | null, was: number | null, fmt: (v: number) => string) =>
    n === null || was === null || n === was ? { text: n === null ? 'No data' : 'No change', tone: 'neutral' } : { text: `${n > was ? '▲' : '▼'} ${fmt(Math.abs(n - was))}`, tone: n > was ? 'bad' : 'good' };

  const change = (n: number, was: number) => (n === was ? { text: 'No change', tone: 'neutral' } : { text: `${n > was ? '▲' : '▼'} ${Math.abs(n - was)}`, tone: n > was ? 'bad' : 'good' });
  const alertsChange = change(inRange.length, before);
  const busiestText = busiest.n === 0 ? `No alerts ${inPeriod}` : `${unit === 'minute' ? `Busiest minute ${hm(busiest.at)}` : unit === 'hour' ? `Busiest hour ${hm(busiest.at)}` : `Busiest day ${dayName(busiest.at)}`} · ${plural(busiest.n, 'alert')}`;
  const fileBase = `overview-${SITE.name.toLowerCase().replace(/\s+/g, '-')}-${new Date(now).toISOString().slice(0, 10)}`;

  const exportSheet = () => {
    const rows: Cell[][] = [
      ['Overview', SITE.name],
      ['Period', period.label],
      ['Exported', new Date(now).toLocaleString()],
      [],
      ['Summary', 'Value'],
      ['Open alerts', open.length],
      ...LEVELS.map((p): Cell[] => [`Open ${p}`, open.filter((a) => a.priority === p).length]),
      ['Escalated', escalated],
      [`Alerts, ${period.title}`, inRange.length],
      ['Cameras online', `${live} of ${cams.length}`],
      ['Degraded cameras', degraded],
      ['Offline cameras', offline],
      ['Reported to QHSE', raised.length],
      ...byType.map((b): Cell[] => [b.t, b.n]),
      [],
      ['Needs attention', 'Level', 'State', 'Camera', 'Area', 'Raised'],
      ...open.map((a): Cell[] => {
        const c = camById.get(a.cameraId);
        return [a.title, a.priority, a.state, c ? `${c.id} ${c.name}` : a.cameraId, AREAS_BY_ID[c?.areaId ?? '']?.name ?? '', new Date(a.at).toLocaleString()];
      }),
      [],
      ['Alerts by area', 'Alerts', 'Open'],
      ...byArea.map((x): Cell[] => [x.a.name, x.n, x.open]),
      [],
      ['Camera health', 'Status', 'Reason'],
      ...faulty.map((c): Cell[] => [`${c.id} ${c.name}`, c.status === 'offline' ? 'Offline' : 'Degraded', healthReason(c)]),
      [],
      ['Hazards detected', 'Count'],
      ...hazards.map((h): Cell[] => [h.name, h.n]),
    ];
    const width = Math.max(...rows.map((r) => r.length));
    download(writeXlsx(rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')), 'Overview'), `${fileBase}.xlsx`);
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
        {view === 'insights' && (
          <div className="ovperiod">
            <PillTabs
              label="Period"
              value={range}
              onChange={(r) => {
                if (r === 'custom') {
                  // Custom starts on the last hour; the panel opens to change the dates and times.
                  if (!custom) setCustom({ from: now - HOUR, to: now });
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
                <span className="dfield__value">
                  {dayTimeShort(custom.from)} | {dayTimeShort(custom.to)}
                </span>
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
            {picking && custom && <TimeRangePanel from={custom.from} to={custom.to} now={now} onChange={(from, to) => setCustom({ from, to })} onClose={() => setPicking(false)} />}
          </div>
        )}
        <span className="spacer" />
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
          <>
            <div className="ovgrid">
              <section className="card ovgrid__6 ovcol">
                <div className="ovcol__kpi ovcol__pair">
                  <button type="button" className="ovcol__stat" onClick={() => nav('/alerts')}>
                    <KpiHead label="Open alerts" icon="warning" tone="bad" />
                    <div className="kpi__value">
                      <span className="kpi__n">{open.length}</span>
                      {open.length > 0 && <span className="kdelta kdelta--bad">{open.filter((a) => a.priority === 'P1').length} P1</span>}
                    </div>
                    <SegBar parts={LEVELS.map((p) => ({ n: open.filter((a) => a.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                    <span className="kpi__foot">{open.length ? `Oldest open ${since(oldest, now)}` : 'Nothing open'}</span>
                  </button>
                  <button type="button" className="ovcol__stat" onClick={() => nav('/alerts')}>
                    <KpiHead label="Escalated, not acknowledged" icon="arrow-up" tone="bad" />
                    <div className="kpi__value">
                      <span className="kpi__n">{escalatedList.length}</span>
                      {escalatedList.length > 0 && <span className="kdelta kdelta--bad">{pct(escalatedList.length, open.length)}% of open</span>}
                    </div>
                    <SegBar parts={LEVELS.map((p) => ({ n: escalatedList.filter((a) => a.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
                    <span className="kpi__foot">{escalatedList.length ? `Waiting longest ${since(oldestEscalated, now)}` : 'Nothing past its response time'}</span>
                  </button>
                </div>
                <div className="card__head">
                  <h2>
                    Needs attention <span className="ovsub">· {open.length} open</span>
                  </h2>
                  <span className="spacer" />
                  <Link to="/alerts" className="ovlink">
                    All alerts
                  </Link>
                </div>
                {open.length === 0 && <p className="card__body meta">No open alerts.</p>}
                <ul className="ovlist ovcol__list">
                  {open.map((a) => {
                    const cam = camById.get(a.cameraId);
                    return (
                      <li key={a.id}>
                        <Link to={`/alerts/${a.id}`} className="ovlist__item">
                          <PriorityBadge p={a.priority} short />
                          <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                            <strong className="ellipsis">{a.title}</strong>
                            <span className="meta ellipsis">
                              {cam?.id} · {cam?.name} · {AREAS_BY_ID[cam?.areaId ?? '']?.name}
                            </span>
                          </span>
                          <span className="ovtime">{since(a.at, now)}</span>
                          <span className="ovstate">
                            <StateChip state={a.state} />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
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
                      <li key={a.id}>
                        <Link to={`/alerts/${a.id}`} className="ovlist__item" title="Open The Alert To Report It">
                          <PriorityBadge p={a.priority} short />
                          <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                            <strong className="ellipsis">{a.title}</strong>
                            <span className="meta ellipsis">
                              {cam?.id} · {since(a.at, now)} ago
                            </span>
                          </span>
                          <span className="ovaction">Report</span>
                        </Link>
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
                  <span className="kpi__foot">{faulty.length ? `${live} of ${cams.length} live` : 'Every camera is live'}</span>
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
                  {faulty.map((c) => (
                    <Link key={c.id} to={`/configuration/cameras/${c.id}`} className="ovcam" title={healthReason(c)}>
                      <span className={`dot dot--${c.status}`} />
                      <span className="mono ovcam__id">{c.id}</span>
<span className="ovcam__state">{c.status === 'offline' ? 'Offline' : 'Degraded'}</span>
                      <span className="ovcam__since" title={`Unavailable since ${hm(unavailableSince(c))}`}>{since(unavailableSince(c), now)}</span>
                    </Link>
                  ))}
                </div>
              </section>

              <section className="card ovgrid__12">
                <div className="card__head">
                  <h2>Coverage gaps</h2>
                  <span className="ovsub">· what the cameras cannot catch yet</span>
                  <span className="spacer" />
                  <Link to="/configuration/cameras" className="ovlink">
                    Configuration
                  </Link>
                </div>
                <div className="ovgaps">
                  <GapList title="No zones drawn" hint="Detection only runs inside zones" items={noZones.map((c) => ({ id: c.id, text: c.name, to: `/configuration/cameras/${c.id}` }))} />
                  <GapList title="Not watched by any rule" hint="No rule raises alerts from these" items={unwatched.map((c) => ({ id: c.id, text: c.name, to: `/configuration/cameras/${c.id}` }))} />
                  <GapList title="Rules still in test" hint="Matches are logged, no one is told" items={testRules.map((r) => ({ id: r.id, text: r.name, to: `/configuration/rules/${r.id}` }))} />
                </div>
              </section>
            </div>
          </>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi">
                <KpiHead label={`Alerts, ${period.title}`} icon="bell" tone="info" />
                <div className="kpi__value">
                  <span className="kpi__n">{inRange.length}</span>
                  <span className={`kdelta kdelta--${alertsChange.tone}`}>{alertsChange.text}</span>
                </div>
                <Spark values={counts.map((c) => c.n)} />
                <span className="kpi__foot">{busiestText}</span>
              </div>

              <div className="kpi">
                <KpiHead label="Mean time to acknowledge" icon="clock" tone="info" />
                <div className="kpi__value">
                  <span className="kpi__n kpi__n--text">{mtta === null ? '–' : duration(mtta)}</span>
                  {(() => {
                    const c = lowerIsBetter(mtta, mttaBefore, duration);
                    return <span className={`kdelta kdelta--${c.tone}`}>{c.text}</span>;
                  })()}
                </div>
                <span className="kpi__foot">{plural(ackTimes(inRange).length, 'alert')} acknowledged {inPeriod}</span>
              </div>

              <div className="kpi">
                <KpiHead label="False alarm rate" icon="check" tone="good" />
                <div className="kpi__value">
                  <span className="kpi__n">{falseRate === null ? '–' : `${falseRate}%`}</span>
                  {(() => {
                    const c = lowerIsBetter(falseRate, falseBefore, (v) => `${v} pts`);
                    return <span className={`kdelta kdelta--${c.tone}`}>{c.text}</span>;
                  })()}
                </div>
                <span className="kpi__foot">
                  Of {plural(closedIn(inRange).length, 'handled alert')} · escalated {escRate === null ? '–' : `${escRate}%`}
                </span>
              </div>

              <button type="button" className="kpi" onClick={() => setReports(true)}>
                <KpiHead label="Reported to QHSE" icon="shield" tone="neutral" />
                <div className="kpi__value">
                  <span className="kpi__n">{raised.length}</span>
                  <span className="kdelta kdelta--neutral">{change(raised.length, raisedBefore).text}</span>
                </div>
                <SegBar parts={byType.map((b) => ({ n: b.n, color: RECORD_COLOR[b.t], label: b.t.toLowerCase() }))} />
                <span className="kpi__foot">From alerts {inPeriod}</span>
              </button>
            </div>

            <div className="ovgrid">
              <section className="card ovgrid__12">
                <div className="card__head">
                  <h2>Alerts by level</h2>
                  <span className="spacer" />
                  <span className="ovmeta">{period.label}</span>
                </div>
                <LevelChart list={inRange} openList={open} start={start} end={end} unreportedOf={unreportedOf} onSend={sendToQhse} />
              </section>

              <section className="card ovgrid__6">
                <div className="card__head">
                  <h2>Alerts by area</h2>
                  <span className="spacer" />
                  <span className="ovmeta">{period.label} · open</span>
                </div>
                <div className="ovrows">
                  {byArea.map(({ a, n, open: o }) => (
                    <div key={a.id} className="ovarea">
                      <span className="ellipsis">{a.name}</span>
                      <span className="ovtrack">
                        <i style={{ width: `${(n / areaMax) * 100}%` }} />
                      </span>
                      <b className="ovnum">{n}</b>
                      <span className={`ovopen${o ? '' : ' is-none'}`}>{o ? `${o} open` : '–'}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card ovgrid__6 ovhazards-card">
                <div className="card__head">
                  <h2>Hazards detected</h2>
                  <span className="spacer" />
                  <span className="ovmeta">{period.label}</span>
                </div>
                {hazards.length === 0 && <p className="card__body meta">No hazards detected {inPeriod}.</p>}
                <div className="ovhazards">
                  {hazards.map((h) => (
                    <div key={h.name} className="ovhazard">
                      <div className="ovhazard__row">
                        <span className="ellipsis">{h.name}</span>
                        <b className="ovnum">{h.n}</b>
                      </div>
                      <span className="ovtrack">
                        <i style={{ width: `${(h.n / hazardMax) * 100}%` }} />
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
      </div>

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

/** The custom period: a start and an end, each a date and a time. Changes apply as they are made. */
function TimeRangePanel({ from, to, now, onChange, onClose }: { from: number; to: number; now: number; onChange: (from: number, to: number) => void; onClose: () => void }) {
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
            if (!Number.isNaN(v)) onChange(Math.min(v, to), to);
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
            if (!Number.isNaN(v)) onChange(from, Math.max(from, Math.min(v, now)));
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
function GapList({ title, hint, items }: { title: string; hint: string; items: { id: string; text: string; to: string }[] }) {
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
          {items.length > 5 && <li className="meta">and {items.length - 5} more</li>}
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
