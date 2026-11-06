import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon, type IconName } from '../components/Icon';
import { QavachReportsDrawer } from '../components/QavachReports';
import { Choice, PriorityBadge, Seg, StateChip } from '../components/ui';
import { AREAS, SITE } from '../data/seed';
import type { Alert, Priority, QavachRecordType } from '../data/types';
import { healthReason } from '../lib/health';
import { dataUrlBytes, jpegToPdf } from '../lib/pdf';
import { download, writeXlsx, type Cell } from '../lib/sheet';
import { ago, hm, useNow } from '../lib/time';
import { AREAS_BY_ID, isOpen, toast, useAlerts, useCameras, useRules } from '../state/store';
import './overview.css';

type Range = 'shift' | '24h' | '7d' | '30d';
type ExportKind = 'pdf' | 'image' | 'excel';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const RANGES: { value: Range; label: string; title: string }[] = [
  { value: 'shift', label: 'This shift', title: 'this shift' },
  { value: '24h', label: 'Last 24 h', title: 'last 24 h' },
  { value: '7d', label: '7 days', title: 'last 7 days' },
  { value: '30d', label: '30 days', title: 'last 30 days' },
];
const LEVELS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const LEVEL_COLOR: Record<Priority, string> = { P1: 'var(--q-p1)', P2: 'var(--q-p2)', P3: 'var(--q-p3)', P4: 'var(--q-p4)' };
const RECORD_COLOR: Record<QavachRecordType, string> = { Incident: 'var(--q-p1)', 'Near miss': 'var(--q-p2)', Observation: '#00B9F2' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (ts: number) => `${new Date(ts).getDate()} ${MONTHS[new Date(ts).getMonth()]}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const since = (ts: number, now: number) => ago(ts, now).replace(' ago', '');

/** When the period starts. Shifts change at 06:00 and 18:00. */
function rangeStart(r: Range, now: number): number {
  if (r === 'shift') {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() >= 18 ? 18 : d.getHours() >= 6 ? 6 : -6);
    return d.getTime();
  }
  return now - (r === '24h' ? DAY : r === '7d' ? 7 * DAY : 30 * DAY);
}

/** Alert counts per hour (shift, 24 h) or per day (7 and 30 days), oldest first. */
function buckets(list: Alert[], r: Range, start: number, now: number) {
  const step = r === '7d' || r === '30d' ? DAY : HOUR;
  const n = Math.max(1, Math.ceil((now - start) / step));
  const counts = Array.from({ length: n }, (_, i) => ({ at: start + i * step, n: 0 }));
  for (const a of list) counts[Math.min(n - 1, Math.floor((a.at - start) / step))].n++;
  return { counts, hourly: step === HOUR };
}

/** One terminal at a time: open alerts, alerts over the period, camera health and what was raised in Qavach,
 *  then the alerts that need attention, where they happen, cameras that need a look and the hazards detected. */
export function Overview() {
  const cams = useCameras();
  const alerts = useAlerts();
  const rules = useRules();
  const now = useNow(5000);
  const nav = useNavigate();
  const [range, setRange] = useState<Range>('24h');
  const [reports, setReports] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  const period = RANGES.find((r) => r.value === range)!;
  const inPeriod = range === 'shift' ? 'this shift' : `in the ${period.title}`;
  const start = rangeStart(range, now);
  const span = now - start;
  const inRange = alerts.filter((a) => a.at >= start && a.at <= now);
  const before = alerts.filter((a) => a.at >= start - span && a.at < start).length;
  const camById = new Map(cams.map((c) => [c.id, c]));
  const open = alerts.filter(isOpen).sort((a, b) => (a.priority === b.priority ? b.at - a.at : a.priority.localeCompare(b.priority)));
  const escalated = open.filter((a) => a.state === 'escalated').length;
  const oldest = open.reduce((m, a) => Math.min(m, a.at), now);
  const { counts, hourly } = buckets(inRange, range, start, now);
  const busiest = counts.reduce((m, b) => (b.n > m.n ? b : m), counts[0]);

  const live = cams.filter((c) => c.status === 'online').length;
  const degraded = cams.filter((c) => c.status === 'degraded').length;
  const offline = cams.filter((c) => c.status === 'offline').length;
  const faulty = cams.filter((c) => c.status !== 'online').sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'offline' ? -1 : 1));

  const raised = alerts.filter((a) => a.qavach && a.qavach.at >= start);
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

  const change = (n: number, was: number) => (n === was ? { text: 'No change', tone: 'neutral' } : { text: `${n > was ? '▲' : '▼'} ${Math.abs(n - was)}`, tone: n > was ? 'bad' : 'good' });
  const alertsChange = change(inRange.length, before);
  const busiestText = busiest.n === 0 ? `No alerts ${inPeriod}` : `${hourly ? `Busiest hour ${hm(busiest.at)}` : `Busiest day ${dayName(busiest.at)}`} · ${plural(busiest.n, 'alert')}`;
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
      ['Raised in Qavach', raised.length],
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
      const url = await toJpeg(node, { quality: 0.95, pixelRatio: 2, backgroundColor: '#F5F6F7', width: w, height: h, style: { margin: '0', padding: '24px', boxSizing: 'content-box' } });
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
      <div className="ovbar">
        <Choice id="ov-site" label="Terminal" className="ovbar__site" value={SITE.name} onChange={() => {}} options={[{ value: SITE.name, label: `${SITE.name} · ${cams.length} cameras` }]} />
        <Seg label="Period" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        <span className="spacer" />
        <ExportMenu onPick={exportAs} />
        <Link to="/wall" className="btn">
          Open video wall
        </Link>
      </div>

      <div ref={sheet} className="ovsheet">
        <div className="ovsheet__title">
          <strong>{SITE.name} · Overview</strong>
          <span>
            {period.label} · exported {new Date(now).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="kpis">
          <button type="button" className="kpi kpi--alert" onClick={() => nav('/alerts')}>
            <KpiHead label="Open alerts" icon="warning" tone="bad" />
            <div className="kpi__value">
              <span className="kpi__n">{open.length}</span>
              {escalated > 0 && <span className="kdelta kdelta--bad">{escalated} escalated</span>}
            </div>
            <SegBar parts={LEVELS.map((p) => ({ n: open.filter((a) => a.priority === p).length, color: LEVEL_COLOR[p], label: p }))} />
            <span className="kpi__foot">{open.length ? `Oldest open ${since(oldest, now)}` : 'Nothing open'}</span>
          </button>

          <div className="kpi">
            <KpiHead label={`Alerts, ${period.title}`} icon="bell" tone="info" />
            <div className="kpi__value">
              <span className="kpi__n">{inRange.length}</span>
              <span className={`kdelta kdelta--${alertsChange.tone}`}>{alertsChange.text}</span>
            </div>
            <Spark values={counts.map((c) => c.n)} />
            <span className="kpi__foot">{busiestText}</span>
          </div>

          <button type="button" className="kpi" onClick={() => nav('/cameras')}>
            <KpiHead label="Cameras online" icon="camera" tone="good" />
            <div className="kpi__value">
              <span className="kpi__n">{live}</span>
              <span className="kpi__of">/ {cams.length}</span>
              <span className="kdelta kdelta--good">{cams.length ? ((live / cams.length) * 100).toFixed(1) : '0'}%</span>
            </div>
            <SegBar
              parts={[
                { n: live, color: '#39BD86', label: 'live' },
                { n: degraded, color: 'var(--q-warn-dot)', label: 'degraded' },
                { n: offline, color: 'var(--q-p1)', label: 'offline' },
              ]}
            />
            <span className="kpi__foot">{faulty.length ? `${plural(faulty.length, 'camera')} need${faulty.length === 1 ? 's' : ''} a look` : 'Every camera is live'}</span>
          </button>

          <button type="button" className="kpi" onClick={() => setReports(true)}>
            <KpiHead label="Raised in Qavach" icon="shield" tone="neutral" />
            <div className="kpi__value">
              <span className="kpi__n">{raised.length}</span>
              <span className="kdelta kdelta--neutral">{change(raised.length, raisedBefore).text}</span>
            </div>
            <SegBar parts={byType.map((b) => ({ n: b.n, color: RECORD_COLOR[b.t], label: b.t.toLowerCase() }))} />
            <span className="kpi__foot">From alerts {inPeriod}</span>
          </button>
        </div>

        <div className="ovgrid">
          <section className="card ovgrid__6">
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
            <ul className="ovlist ovlist--five">
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

          <section className="card ovgrid__3">
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

          <section className="card ovgrid__3">
            <div className="card__head">
              <h2>Camera health</h2>
              <span className="spacer" />
              <Link to="/cameras" className="ovlink">
                Cameras
              </Link>
            </div>
            {faulty.length === 0 && <p className="card__body meta">Every camera is live.</p>}
            <div className="ovrows">
              {faulty.map((c) => (
                <Link key={c.id} to={`/cameras/${c.id}`} className="ovcam">
                  <span className={`dot dot--${c.status}`} />
                  <span className="mono ovcam__id">{c.id}</span>
                  <span className="ovcam__why ellipsis" title={healthReason(c)}>
                    {healthReason(c)}
                  </span>
                  <span className="ovcam__state">{c.status === 'offline' ? 'Offline' : 'Degraded'}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="card ovgrid__12">
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
      </div>

      {reports && <QavachReportsDrawer onClose={() => setReports(false)} />}
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
        {total === 0 ? <span style={{ flex: 1, background: '#E9EDEE' }} /> : parts.filter((p) => p.n > 0).map((p) => <span key={p.label} style={{ flex: p.n, background: p.color }} title={`${p.n} ${p.label}`} />)}
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
        <polygon points={`0,${h} ${line} ${w},${h}`} fill="rgba(0, 185, 242, .14)" />
        <polyline points={line} fill="none" stroke="#00B9F2" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
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
      <button type="button" className="btn btn--secondary" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
        <Icon name="download" size={18} />
        {busy ? 'Exporting…' : 'Export'}
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
