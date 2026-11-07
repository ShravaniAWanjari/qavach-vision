import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AckDialog, EscalateDialog, NoteDialog, RaiseDialog } from '../../components/AlertDialogs';
import { Icon } from '../../components/Icon';
import { QavachReportsLink } from '../../components/QavachReports';
import { CameraView, CHANNEL, Choice, PRIORITY_NAME, Empty, PriorityBadge, Seg, StateChip } from '../../components/ui';
import { AREAS } from '../../data/seed';
import type { Alert, Priority } from '../../data/types';
import { activityText, describeRule } from '../../lib/qai';
import { ago, dayTime, duration, hms, useNow } from '../../lib/time';
import { AREAS_BY_ID, isOpen, roleText, useAlerts, useCameras, usePolicies, useRules, userName, USERS_BY_ID } from '../../state/store';
import './alerts.css';
import { assetUrl } from '../../lib/assets';

type Tab = 'open' | 'acknowledged' | 'closed' | 'all';

const inTab = (a: Alert, t: Tab) =>
  t === 'all' ? true : t === 'open' ? isOpen(a) : t === 'acknowledged' ? a.state === 'acknowledged' : a.state === 'resolved' || a.state === 'false-alarm';

type Sort = 'newest' | 'crit-low' | 'crit-high' | 'open-first' | 'ack-first' | 'closed-first';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'crit-high', label: 'Criticality: High to low' },
  { value: 'crit-low', label: 'Criticality: Low to high' },
  { value: 'open-first', label: 'Status: Open first' },
  { value: 'ack-first', label: 'Status: Acknowledged first' },
  { value: 'closed-first', label: 'Status: Closed first' },
];
const stateRank = (a: Alert) => (a.state === 'acknowledged' ? 1 : a.state === 'resolved' || a.state === 'false-alarm' ? 2 : 0);

export function Alerts() {
  const { alertId } = useParams();
  const nav = useNavigate();
  const alerts = useAlerts();
  const cams = useCameras();
  const now = useNow(1000);
  // Links from the Overview can open the list already narrowed: ?level=P1&tab=open
  const [params] = useSearchParams();
  const startTab = params.get('tab');
  const startLevel = params.get('level');
  const [tab, setTab] = useState<Tab>(startTab === 'open' || startTab === 'acknowledged' || startTab === 'closed' ? startTab : 'all');
  const [prio, setPrio] = useState<Priority | 'all'>(startLevel === 'P1' || startLevel === 'P2' || startLevel === 'P3' || startLevel === 'P4' ? startLevel : 'all');
  const [area, setArea] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  // Opened from a camera (its badge on the video wall): only that camera's alerts, kept while you click through them.
  const onlyCam = params.get('camera') ?? '';
  const keep = onlyCam ? `?camera=${encodeURIComponent(onlyCam)}` : '';
  const camById = useMemo(() => new Map(cams.map((c) => [c.id, c])), [cams]);

  const filtered = alerts.filter((a) => {
    if (onlyCam && a.cameraId !== onlyCam) return false;
    if (!inTab(a, tab)) return false;
    if (prio !== 'all' && a.priority !== prio) return false;
    const cam = camById.get(a.cameraId);
    if (area !== 'all' && cam?.areaId !== area) return false;
    const t = q.trim().toLowerCase();
    return !t || `${a.id} ${a.title} ${cam?.id} ${cam?.name} ${a.qavach?.ref ?? ''}`.toLowerCase().includes(t);
  });
  // P1 is the most critical. Ties fall back to newest first.
  const prioNo = (a: Alert) => Number(a.priority.slice(1));
  const first = sort === 'open-first' ? 0 : sort === 'ack-first' ? 1 : 2;
  const rank = (a: Alert) => (stateRank(a) === first ? 0 : stateRank(a) === 0 ? 1 : stateRank(a) === 1 ? 2 : 3);
  filtered.sort((a, b) => {
    const d = sort === 'crit-high' ? prioNo(a) - prioNo(b) : sort === 'crit-low' ? prioNo(b) - prioNo(a) : sort === 'newest' ? 0 : rank(a) - rank(b);
    return d || b.at - a.at;
  });
  const activeFilters = [tab !== 'all', prio !== 'all', area !== 'all', q.trim() !== ''].filter(Boolean).length;
  const selected = alerts.find((a) => a.id === alertId);
  const openCount = alerts.filter(isOpen).length;

  return (
    <div className="page page--wide">
      <div className="albar">
        <button type="button" className={`albar__btn${filtersOpen ? ' is-open' : ''}`} aria-expanded={filtersOpen} aria-controls="al-filters" onClick={() => setFiltersOpen((v) => !v)}>
          <Icon name="search" size={18} stroke={2} />
          Search &amp; Filter
          {activeFilters > 0 && <span className="albar__count">{activeFilters}</span>}
          <Icon name="chevron-down" size={16} stroke={2} />
        </button>
        <div className="albar__sort"><Choice id="al-sort" label="Sort By" clearTo="newest" value={sort} onChange={setSort} options={SORTS} /></div>
      </div>
      {filtersOpen && (
      <div className="qsearch" id="al-filters">
        <div className="qsearch__fields">
          <div className="field">
            <label htmlFor="al-q">Search</label>
            <input id="al-q" className="input" placeholder="Search alerts" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Choice
            id="al-state"
            label="Alert State"
            value={tab}
            clearTo="all"
            onChange={setTab}
            options={[
              { value: 'all' as Tab, label: 'All' },
              { value: 'open' as Tab, label: `Open${openCount ? ` (${openCount})` : ''}` },
              { value: 'acknowledged' as Tab, label: 'Acknowledged' },
              { value: 'closed' as Tab, label: 'Closed' },
            ]}
          />
          <Choice id="al-level" label="Alert Level" clearTo="all" value={prio} onChange={setPrio} options={[{ value: 'all' as Priority | 'all', label: 'All levels' }, ...(['P1', 'P2', 'P3', 'P4'] as const).map((p) => ({ value: p as Priority | 'all', label: `${p} ${PRIORITY_NAME[p]}` }))]} />
          <Choice id="al-area" label="Area" clearTo="all" value={area} onChange={setArea} options={[{ value: 'all', label: 'All areas' }, ...AREAS.map((a) => ({ value: a.id, label: a.name }))]} />
        </div>
        <button
          type="button"
          className="qsearch__clear"
          onClick={() => {
            setTab('all');
            setPrio('all');
            setArea('all');
            setQ('');
          }}
        >
          Clear Search
        </button>
      </div>
      )}

      <div className="listing-row">
        <span className="listing-tag">
          Listing 1 - {filtered.length} Of {alerts.length} · {openCount} open · <QavachReportsLink />
        </span>
        {onlyCam && (
          <span className="camfilter">
            <Icon name="camera" size={16} />
            Camera {onlyCam}
            {camById.get(onlyCam) && <span className="camfilter__name">· {camById.get(onlyCam)!.name}</span>}
            <button type="button" onClick={() => nav(`/alerts${alertId ? `/${alertId}` : ''}`)} aria-label="Show all cameras" title="Show All Cameras">
              <Icon name="close" size={14} stroke={2.2} />
            </button>
          </span>
        )}
        <button type="button" className="listing-row__gear" onClick={() => setSettings(true)} aria-label="Settings" title="Settings">
          <img src={assetUrl('qv/hdr/gear.png')} width={24} height={24} alt="" />
        </button>
      </div>

      {settings && (
        <>
          <div className="qset-scrim" onClick={() => setSettings(false)} />
          <aside className="qset" role="dialog" aria-modal="true" aria-label="Settings">
            <strong className="qset__title">Settings</strong>
            <div className="qset__body">
              <div className="qset__sub">Alerts</div>
              <button type="button" className="qset__item" onClick={() => {
                setSettings(false);
                nav('/configuration/alerts');
              }}>
                Configure alerts
                <Icon name="chevron-right" size={16} stroke={2} />
              </button>
            </div>
            <div className="qset__foot">
              <button type="button" className="btn qset__cancel" onClick={() => setSettings(false)}>
                Cancel
              </button>
            </div>
          </aside>
        </>
      )}

      <div className={`alerts${selected ? ' alerts--detail' : ''}`}>
        <section className="alerts__list">
          {filtered.length === 0 ? (
            <Empty icon="shield" title="No Alerts Here">
              Change the filters to see more.
            </Empty>
          ) : (
            <ul className="alist">
              {filtered.map((a) => {
                const cam = camById.get(a.cameraId);
                return (
                  <li key={a.id}>
                    <button type="button" className={`alist__item${a.id === alertId ? ' is-selected' : ''}${isOpen(a) ? ' is-open' : ''}`} onClick={() => nav(`/alerts/${a.id}${keep}`)}>
                      <span className="alist__lvl">
                        <PriorityBadge p={a.priority} short />
                      </span>
                      <span className="alist__main">
                        <span className="alist__title">{a.title}</span>
                        <span className="alist__id">{a.id}</span>
                        <span className="meta ellipsis">
                          {cam?.id} {cam?.name} · {AREAS_BY_ID[cam?.areaId ?? '']?.name}
                        </span>
                      </span>
                      <span className="alist__side">
                        <StateChip state={a.state} />
                        {a.qavach && <span className="chip chip--outline mono" title={`QHSE Report ${a.qavach.ref}`}>{a.qavach.ref}</span>}
                        <span className="meta">{ago(a.at, now)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {selected ? (
          <AlertDetail alert={selected} onClose={() => nav(`/alerts${keep}`)} />
        ) : (
          <section className="card alerts__hint">
            <Empty icon="bell" title="Pick An Alert">
              See the snapshot, the rule that fired, who was told and how, and raise it in QHSE.
            </Empty>
          </section>
        )}
      </div>
    </div>
  );
}

function AlertDetail({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const cams = useCameras();
  const rules = useRules();
  const policies = usePolicies();
  const now = useNow(1000);
  const [dialog, setDialog] = useState<'ack' | 'raise' | 'resolve' | 'false' | 'escalate'>();
  const [live, setLive] = useState(false);
  const cam = cams.find((c) => c.id === alert.cameraId);
  const rule = rules.find((r) => r.id === alert.ruleId);
  const policy = policies.find((p) => p.priority === alert.priority);
  if (!cam)
    return (
      <div className="card" style={{ padding: 16 }}>
        <strong>{alert.id} · {alert.title}</strong>
        <p className="meta">Camera {alert.cameraId} has been removed, so there is no picture to show. The alert is kept as history.</p>
      </div>
    );
  const zoneNames = cam.zones.filter((z) => rule?.zoneIds.includes(z.id)).map((z) => z.name);
  const zoneName = cam.zones.find((z) => z.id === alert.zoneId)?.name ?? (zoneNames.length === 1 ? zoneNames[0] : undefined);
  const open = isOpen(alert);
  const dueAt = policy ? alert.at + policy.ackWithinMin * 60000 : 0;

  return (
    <section className="card adetail" aria-label={`Alert ${alert.id}`}>
      <div className="adetail__head">
        <PriorityBadge p={alert.priority} />
        <span className="mono">{alert.id}</span>
        <StateChip state={alert.state} />
        <span className="spacer" />
        <a href={`#/m/${alert.id}`} target="_blank" rel="noopener" className="btn btn--ghost btn--sm" title="What The Supervisor Sees On The Phone">
          <Icon name="mobile" size={15} />
          Phone view
        </a>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="adetail__body">
        <h2 className="adetail__title">{alert.title}</h2>
        <p className="muted">
          {alert.detail} · {Math.round(alert.confidence * 100)}% confidence · {dayTime(alert.at)}
        </p>

        {open && policy && (
          <div className={`adetail__due${alert.state === 'escalated' ? ' is-late' : ''}`}>
            <Icon name="clock" size={17} />
            {alert.state === 'escalated' ? (
              <span>
                Not acknowledged in {policy.ackWithinMin}min · escalated to <strong>{userName(alert.escalatedTo)}</strong>
              </span>
            ) : policy.escalateTo === 'none' ? (
              <span>Open for {duration(now - alert.at)} · {policy.priority} alerts are not escalated</span>
            ) : (
              <span>
                Acknowledge within {policy.ackWithinMin}min · escalates to the {roleText(policy.escalateTo)} in <strong className="mono">{duration(Math.max(0, dueAt - now))}</strong>
              </span>
            )}
          </div>
        )}

        <div className="adetail__media">
          <CameraView cam={cam} still={!live} alert={live ? undefined : alert} zones={cam.zones} highlightZones={alert.zoneId ? [alert.zoneId] : undefined} showZoneLabels now={live ? now : undefined} />
          <div className="row-wrap">
            <Seg
              label="Picture"
              small
              value={live ? 'live' : 'snap'}
              onChange={(v) => setLive(v === 'live')}
              options={[
                { value: 'snap', label: `Snapshot · ${hms(alert.at)}` },
                { value: 'live', label: 'Live now' },
              ]}
            />
            <span className="meta">
              {cam.id} {cam.name} · {AREAS_BY_ID[cam.areaId]?.name}
            </span>
          </div>
        </div>

        <div className="adetail__actions">
          {/* In the order they are usually done: acknowledge, escalate if needed, then report to QHSE. */}
          {open && (
            <button type="button" className="btn btn--act btn--act-ack" onClick={() => setDialog('ack')}>
              <Icon name="check" size={16} />
              Acknowledge
            </button>
          )}
          {open && (
            <button type="button" className="btn btn--act btn--act-esc" onClick={() => setDialog('escalate')}>
              <Icon name="arrow-right" size={16} />
              Escalate
            </button>
          )}
          {!alert.qavach && alert.state !== 'false-alarm' && (
            <button type="button" className="btn btn--act btn--report" onClick={() => setDialog('raise')}>
              <Icon name="send" size={16} />
              Report to QHSE
            </button>
          )}
          {alert.state === 'acknowledged' && (
            <button type="button" className="btn btn--secondary" onClick={() => setDialog('resolve')}>
              Resolve
            </button>
          )}
          {alert.state !== 'resolved' && alert.state !== 'false-alarm' && (
            <button type="button" className="btn btn--ghost" onClick={() => setDialog('false')}>
              <Icon name="ban" size={16} />
              False alarm
            </button>
          )}
        </div>

        {alert.qavach && (
          <div className="qrec">
            <div className="qrec__head">
              <span className="qrec__badge">
                <Icon name="shield" size={15} />
                Qavach
              </span>
              <strong>
                {alert.qavach.type} <span className="mono" title={`QHSE Report ${alert.qavach.ref}`}>{alert.qavach.ref}</span>
              </strong>
              <span className="chip">{alert.qavach.severity}</span>
              <span className="chip">{alert.qavach.classification}</span>
              <span className="spacer" />
              <span className="meta">
                {alert.qavach.source === 'auto' ? 'Raised on acknowledgement (policy)' : alert.qavach.source === 'mobile' ? 'Raised from the phone' : 'Raised from the console'} by {userName(alert.qavach.createdBy)} · {ago(alert.qavach.at, now)}
              </span>
            </div>
            <strong>{alert.qavach.title}</strong>
            <p>{alert.qavach.description}</p>
            <p className="meta">Immediate action: {alert.qavach.immediateAction}</p>
            <p className="meta">In QHSE: Incidents and Learning · {alert.qavach.type === 'Incident' ? 'Incident register' : alert.qavach.type === 'Near miss' ? 'Near-miss register' : 'Observations'} · snapshot and 20s clip attached</p>
          </div>
        )}

        <div className="grid-2 adetail__cols">
          <div className="stack">
            <h3>Rule that fired</h3>
            {rule ? (
              <Link to={`/configuration/rules/${rule.id}`} className="rulecard">
                <span className="mono">{rule.id}</span>
                <strong>{rule.name}</strong>
                <span className="meta">{describeRule(rule, zoneNames)}</span>
                <span className="meta">
                  {rule.cameraIds.length} cameras · {rule.mode === 'live' ? 'Live' : 'Test'} · creates {rule.qavach === 'none' ? 'no QHSE report' : `a QHSE ${rule.qavach.toLowerCase()}`}
                </span>
              </Link>
            ) : (
              <span className="meta">The rule has been deleted.</span>
            )}
            <h3>Activity</h3>
            <ol className="timeline">
              {[...alert.activity].reverse().map((e, i) => (
                <li key={i}>
                  <span className="timeline__text">{activityText(e.text, rule, zoneName)}</span>
                  <span className="timeline__meta">
                    <span className="mono">{hms(e.at)}</span>
                    {e.actor !== 'system' && ` · ${userName(e.actor)}`}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="stack">
            <h3>People Alerted ({alert.deliveries.length})</h3>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Person</th>
                  <th>Channel</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {alert.deliveries.map((d, i) => (
                  <tr key={i}>
                    <td className="mono">{hms(d.at)}</td>
                    <td>
                      {userName(d.to)}
                      <div className="meta">
                        {USERS_BY_ID[d.to]?.role}
                        {d.reason !== 'alert' && ` · ${d.reason}`}
                      </div>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 5 }}>
                        <Icon name={CHANNEL[d.channel].icon} size={15} />
                        {CHANNEL[d.channel].label}
                      </span>
                    </td>
                    <td>
                      <span className={`chip ${d.status === 'read' ? 'chip--good' : d.status === 'failed' ? 'chip--danger' : ''}`}>{d.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {dialog === 'ack' && <AckDialog alert={alert} via="console" onClose={() => setDialog(undefined)} />}
      {dialog === 'raise' && <RaiseDialog alert={alert} onClose={() => setDialog(undefined)} />}
      {dialog === 'escalate' && <EscalateDialog alert={alert} onClose={() => setDialog(undefined)} />}
      {(dialog === 'resolve' || dialog === 'false') && <NoteDialog alert={alert} kind={dialog} onClose={() => setDialog(undefined)} />}
    </section>
  );
}

