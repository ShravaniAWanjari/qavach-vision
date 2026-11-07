import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Alert } from '../data/types';
import { ago, useNow } from '../lib/time';
import { reportsSeenStore, useAlerts, useReportsSeen, userName } from '../state/store';
import { Icon } from './Icon';
import { Drawer } from './ui';
import '../pages/overview.css';

/** Alerts reported to QHSE, newest first, and how many were raised since the panel was last opened. */
export function useQavachReports(): { records: Alert[]; fresh: number } {
  const alerts = useAlerts();
  const seen = useReportsSeen();
  const records = alerts.filter((a) => a.qavach).sort((a, b) => b.qavach!.at - a.qavach!.at);
  return { records, fresh: records.filter((a) => a.qavach!.at > seen).length };
}

/** The QHSE reports side panel. Opening it marks every report as seen; the ones that were new keep their tag until it closes. */
export function QavachReportsDrawer({ onClose }: { onClose: () => void }) {
  const { records } = useQavachReports();
  const now = useNow(5000);
  const [seenBefore] = useState(() => reportsSeenStore.get());
  useEffect(() => reportsSeenStore.set(() => Date.now()), []);
  return (
    <Drawer title="Reported to QHSE" sub="Incidents, near misses and observations raised from alerts" onClose={onClose}>
      {records.length === 0 && <p className="meta">None yet.</p>}
      <ul className="ovlist ovlist--flush">
        {records.map((a) => (
          <li key={a.id}>
            <Link to={`/alerts/${a.id}`} className="ovlist__item" onClick={onClose}>
              <span className="qrec__badge">
                <Icon name="shield" size={14} />
                {a.qavach!.type}
              </span>
              <span className="stack" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                <strong className="ellipsis">
                  <span className="mono">{a.qavach!.ref}</span> · {a.qavach!.title}
                </strong>
                <span className="meta ellipsis">
                  {a.qavach!.severity} · {a.qavach!.classification} · {userName(a.qavach!.createdBy)} · {ago(a.qavach!.at, now)}
                </span>
              </span>
              {a.qavach!.at > seenBefore && <span className="qrec__new">New</span>}
            </Link>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

/** "2 new QHSE reports" in the success green, as a text link that opens the panel. */
export function QavachReportsLink() {
  const { records, fresh } = useQavachReports();
  const [open, setOpen] = useState(false);
  if (!records.length) return null;
  return (
    <>
      <button type="button" className="qreports-link" onClick={() => setOpen(true)}>
        {fresh ? `${fresh} new Qavach ${fresh === 1 ? 'report' : 'reports'}` : `${records.length} Qavach ${records.length === 1 ? 'report' : 'reports'}`}
      </button>
      {open && <QavachReportsDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
