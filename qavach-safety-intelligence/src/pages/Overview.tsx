import { useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { QavachReportsDrawer } from '../components/QavachReports';
import { PriorityBadge, StateChip } from '../components/ui';
import { AREAS } from '../data/seed';
import { healthReason } from '../lib/health';
import { ago, useNow } from '../lib/time';
import { AREAS_BY_ID, isOpen, useAlerts, useCameras } from '../state/store';
import './overview.css';

export function Overview() {
  const cams = useCameras();
  const alerts = useAlerts();
  const now = useNow(5000);
  const [reports, setReports] = useState(false);

  const open = alerts.filter(isOpen);
  const camById = new Map(cams.map((c) => [c.id, c]));
  const day = alerts.filter((a) => now - a.at < 86400000);
  const faulty = cams.filter((c) => c.status !== 'online').sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'offline' ? -1 : 1));

  const byArea = AREAS.map((a) => ({ a, n: day.filter((x) => camById.get(x.cameraId)?.areaId === a.id).length })).sort((x, y) => y.n - x.n);

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__actions">
          <button type="button" className="btn btn--secondary" onClick={() => setReports(true)}>
            <Icon name="shield" size={16} />
            Raised in Qavach
          </button>
        </div>
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
          <ul className="ovlist ovlist--five">
            {open.slice(0, 50).map((a) => {
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
            <h2>Cameras not working</h2>
          </div>
          {faulty.length === 0 && <p className="card__body meta">Every camera is working.</p>}
          <ul className="ovlist ovlist--five">
            {faulty.map((c) => (
              <li key={c.id}>
                <Link to={`/cameras/${c.id}`} className="ovlist__item">
                  <span className={`dot dot--${c.status}`} />
                  <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                    <strong className="ellipsis">
                      <span className="mono">{c.id}</span> {c.name}
                    </strong>
                    <span className="meta ellipsis">
                      {AREAS_BY_ID[c.areaId]?.name} · {healthReason(c)}
                    </span>
                  </span>
                  <span className="chip chip--outline">{c.status === 'offline' ? 'Offline' : 'Degraded'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="ovrow ovrow--one">
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
      </div>

      {reports && <QavachReportsDrawer onClose={() => setReports(false)} />}
    </div>
  );
}
