import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { PriorityBadge, StateChip } from '../components/ui';
import { AREAS, SITE } from '../data/seed';
import type { Alert, Condition } from '../data/types';
import { ago, duration, useNow } from '../lib/time';
import { isOpen, useAlerts, useCameras, useMe, usePolicies, useRules, userName } from '../state/store';
import { Onboarding } from './Onboarding';
import './overview.css';

const HAZARD: Record<Condition, string> = {
  enters: 'Person enters a zone',
  outside: 'Person away from walkway',
  dwells: 'Stays in a zone',
  crosses: 'Line crossed',
  'no-ppe': 'No PPE',
  crowd: 'Crowding',
  smoke: 'Smoke or flame',
  stopped: 'Vehicle stopped',
};
const CHART = ['var(--q-chart-1)', 'var(--q-chart-2)', 'var(--q-chart-3)', 'var(--q-chart-4)', 'var(--q-chart-5)'];
const HOURS = 3;
const BUCKETS = 8;

export function Overview() {
  const me = useMe();
  const cams = useCameras();
  const rules = useRules();
  const alerts = useAlerts();
  const policies = usePolicies();
  const now = useNow(5000);

  const open = alerts.filter(isOpen);
  const camById = new Map(cams.map((c) => [c.id, c]));
  const day = alerts.filter((a) => now - a.at < 86400000);
  const acked = day.filter((a) => a.ackAt);
  const inTime = acked.filter((a) => {
    const p = policies.find((x) => x.priority === a.priority);
    return p && a.ackAt! - a.at <= p.ackWithinMin * 60000;
  });
  const median = (list: Alert[]) => (list.length ? list.map((a) => a.ackAt! - a.at).sort((x, y) => x - y)[Math.floor(list.length / 2)] : 0);
  const records = alerts.filter((a) => a.qavach).sort((a, b) => b.qavach!.at - a.qavach!.at);
  const online = cams.filter((c) => c.status === 'online').length;
  const hour = new Date(now).getHours();

  // Top hazards: alerts in the last 24 h by the condition of the rule that raised them.
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  day.forEach((a) => {
    const c = ruleById.get(a.ruleId)?.condition;
    const label = c ? HAZARD[c] : 'Other';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  const hazards = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const top = hazards.slice(0, 4);
  const rest = hazards.slice(4).reduce((s, [, n]) => s + n, 0);
  const pie = rest ? [...top, ['Other', rest] as [string, number]] : top;

  const byArea = AREAS.map((a) => ({ a, n: day.filter((x) => camById.get(x.cameraId)?.areaId === a.id).length })).sort((x, y) => y.n - x.n);

  const levels = (['P1', 'P2', 'P3', 'P4'] as const).map((p) => {
    const list = day.filter((a) => a.priority === p);
    const done = list.filter((a) => a.ackAt);
    return { p, n: list.length, open: list.filter(isOpen).length, median: median(done) };
  });

  const bucketMs = HOURS * 3600000;
  const start = now - BUCKETS * bucketMs;
  const slot = (t: number) => Math.floor((t - start) / bucketMs);
  const raised = Array<number>(BUCKETS).fill(0);
  const handled = Array<number>(BUCKETS).fill(0);
  alerts.forEach((a) => {
    const i = slot(a.at);
    if (i >= 0 && i < BUCKETS) raised[i]++;
    const j = a.ackAt ? slot(a.ackAt) : -1;
    if (j >= 0 && j < BUCKETS) handled[j]++;
  });
  const labels = raised.map((_, i) => new Date(start + (i + 1) * bucketMs).getHours().toString().padStart(2, '0') + ':00');

  const states: [string, number][] = [
    ['New', alerts.filter((a) => a.state === 'new').length],
    ['Escalated', alerts.filter((a) => a.state === 'escalated').length],
    ['Acknowledged', alerts.filter((a) => a.state === 'acknowledged').length],
    ['Resolved', alerts.filter((a) => a.state === 'resolved').length],
    ['False alarm', alerts.filter((a) => a.state === 'false-alarm').length],
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__title">
          <h1>
            Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.name.split(' ')[0]}
          </h1>
          <span className="page__sub">
            {SITE.name} · {cams.length} cameras · {AREAS.length} areas. Detections become alerts, alerts become Qavach records.
          </span>
        </div>
        <div className="page__actions">
          <Link to="/alerts" className="btn btn--secondary">
            <Icon name="bell" size={16} />
            Alerts
          </Link>
          <Link to="/wall" className="btn">
            <Icon name="wall" size={16} />
            Open the video wall
          </Link>
        </div>
      </div>

      <div className="ovkpis">
        <div className="card kpi">
          <span className="kpi__label">Open alerts</span>
          <span className="kpi__value">{open.length}</span>
        </div>
        <div className="card kpi">
          <span className="kpi__label">Alerts in the last 24 h</span>
          <span className="kpi__value">{day.length}</span>
        </div>
        <div className="card kpi">
          <span className="kpi__label">Cameras online</span>
          <span className="kpi__value">
            {online}
            <small>of {cams.length}</small>
          </span>
        </div>
        <div className="card kpi">
          <span className="kpi__label">Acknowledged in time</span>
          <span className="kpi__value">{acked.length ? Math.round((inTime.length / acked.length) * 100) : 100}%</span>
        </div>
        <div className="card kpi">
          <span className="kpi__label">Median time to acknowledge</span>
          <span className="kpi__value">{median(acked) ? duration(median(acked)) : '–'}</span>
        </div>
        <div className="card kpi">
          <span className="kpi__label">Sent to Qavach</span>
          <span className="kpi__value">{records.length}</span>
        </div>
      </div>

      <div className="ovrow">
        <section className="card">
          <div className="card__head">
            <h2>Top hazards, 24 h</h2>
          </div>
          <div className="pie">
            {pie.length === 0 ? (
              <p className="meta">No alerts in the last 24 hours.</p>
            ) : (
              <>
                <Pie data={pie} />
                <ul className="legend">
                  {pie.map(([label, n], i) => (
                    <li key={label}>
                      <span className="legend__sw" style={{ background: CHART[i % CHART.length] }} />
                      <span className="ellipsis">{label}</span>
                      <strong>{n}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2>Work area</h2>
          </div>
          <ul className="workarea">
            {byArea.map(({ a, n }) => (
              <li key={a.id}>
                <Link to="/alerts" className="workarea__row">
                  <span className="ellipsis">{a.name}</span>
                  <span className="workarea__n">{n}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="card__head">
            <h2>Alert levels, 24 h</h2>
          </div>
          <table className="table ovtable">
            <thead>
              <tr>
                <th>Level</th>
                <th>Alerts</th>
                <th>Open</th>
                <th>Median time to acknowledge</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.p}>
                  <td>
                    <PriorityBadge p={l.p} />
                  </td>
                  <td className="tint-blue">{l.n}</td>
                  <td className="tint-yellow">{l.open}</td>
                  <td className="tint-blue">{l.median ? duration(l.median) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="ovrow ovrow--charts">
        <section className="card">
          <div className="card__head">
            <h2>Alerts trend</h2>
          </div>
          <Trend raised={raised} handled={handled} labels={labels} />
        </section>
        <section className="card">
          <div className="card__head">
            <h2>Alerts by status</h2>
          </div>
          <Bars data={states} />
        </section>
      </div>

      <div className="ovrow ovrow--lists">
        <section className="card">
          <div className="card__head">
            <h2>Needs attention</h2>
            <span className="spacer" />
            <Link to="/alerts" className="meta">
              All alerts
            </Link>
          </div>
          {open.length === 0 && <p className="card__body meta">No open alerts.</p>}
          <ul className="ovlist">
            {open.slice(0, 6).map((a) => {
              const cam = camById.get(a.cameraId);
              return (
                <li key={a.id}>
                  <Link to={`/alerts/${a.id}`} className="ovlist__item">
                    <PriorityBadge p={a.priority} short />
                    <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                      <strong className="ellipsis">{a.title}</strong>
                      <span className="meta ellipsis">
                        {cam?.id} {cam?.name} · {ago(a.at, now)}
                      </span>
                    </span>
                    <StateChip state={a.state} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="card">
          <div className="card__head">
            <h2>Sent to Qavach</h2>
            <span className="meta">Incidents, near misses and observations raised from alerts</span>
          </div>
          {records.length === 0 && <p className="card__body meta">None yet.</p>}
          <ul className="ovlist">
            {records.slice(0, 5).map((a) => (
              <li key={a.id}>
                <Link to={`/alerts/${a.id}`} className="ovlist__item">
                  <span className="qrec__badge">
                    <Icon name="shield" size={14} />
                    {a.qavach!.type}
                  </span>
                  <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                    <strong className="ellipsis">
                      <span className="mono">{a.qavach!.ref}</span> · {a.qavach!.title}
                    </strong>
                    <span className="meta ellipsis">
                      {a.qavach!.severity} · {a.qavach!.classification} · {a.qavach!.source === 'mobile' ? 'from the phone' : a.qavach!.source === 'auto' ? 'on acknowledgement' : 'from the console'} by {userName(a.qavach!.createdBy)} · {ago(a.qavach!.at, now)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section style={{ marginTop: 20 }}>
        <h2 style={{ marginBottom: 10 }}>Set-up</h2>
        <Onboarding />
      </section>
    </div>
  );
}

function Pie({ data }: { data: [string, number][] }) {
  const total = data.reduce((s, [, n]) => s + n, 0) || 1;
  let angle = -Math.PI / 2;
  const R = 92;
  return (
    <svg className="pie__svg" viewBox="-100 -100 200 200" role="img" aria-label="Alerts by hazard">
      {data.map(([label, n], i) => {
        const a1 = angle;
        const a2 = angle + (n / total) * Math.PI * 2;
        angle = a2;
        if (data.length === 1) return <circle key={label} r={R} fill={CHART[0]} />;
        const large = a2 - a1 > Math.PI ? 1 : 0;
        const d = `M0 0 L${R * Math.cos(a1)} ${R * Math.sin(a1)} A${R} ${R} 0 ${large} 1 ${R * Math.cos(a2)} ${R * Math.sin(a2)}Z`;
        return <path key={label} d={d} fill={CHART[i % CHART.length]} stroke="#fff" strokeWidth="1.5" />;
      })}
    </svg>
  );
}

function Trend({ raised, handled, labels }: { raised: number[]; handled: number[]; labels: string[] }) {
  const W = 620;
  const H = 230;
  const L = 34;
  const B = 28;
  const max = Math.max(4, ...raised, ...handled);
  const x = (i: number) => L + (i * (W - L - 12)) / (raised.length - 1);
  const y = (v: number) => H - B - (v / max) * (H - B - 18);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
  return (
    <div className="chart">
      <div className="chart__legend">
        <span className="chart__key chart__key--a">Raised</span>
        <span className="chart__key chart__key--b">Acknowledged</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Alerts raised and acknowledged per three hours">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#E4E7E9" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#567C87">
              {t}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text key={l + i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11.5" fill="#567C87">
            {l}
          </text>
        ))}
        <path d={line(raised)} fill="none" stroke="var(--q-chart-4)" strokeWidth="2" />
        <path d={line(handled)} fill="none" stroke="var(--q-chart-2)" strokeWidth="2" />
        {raised.map((v, i) => (
          <circle key={`a${i}`} cx={x(i)} cy={y(v)} r="3.5" fill="var(--q-chart-4)" />
        ))}
        {handled.map((v, i) => (
          <circle key={`b${i}`} cx={x(i)} cy={y(v)} r="3.5" fill="var(--q-chart-2)" />
        ))}
      </svg>
    </div>
  );
}

function Bars({ data }: { data: [string, number][] }) {
  const W = 620;
  const H = 230;
  const L = 34;
  const B = 28;
  const max = Math.max(4, ...data.map(([, n]) => n));
  const slotW = (W - L - 12) / data.length;
  const y = (v: number) => H - B - (v / max) * (H - B - 18);
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
  return (
    <div className="chart">
      <div className="chart__legend">
        <span className="chart__key chart__key--b">Alerts</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Alerts by status">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#E4E7E9" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#567C87">
              {t}
            </text>
          </g>
        ))}
        {data.map(([label, n], i) => (
          <g key={label}>
            <rect x={L + i * slotW + slotW * 0.28} y={y(n)} width={slotW * 0.44} height={Math.max(0, H - B - y(n))} fill="var(--q-chart-2)" />
            <text x={L + i * slotW + slotW / 2} y={H - 8} textAnchor="middle" fontSize="11.5" fill="#567C87">
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
