import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon, Logo, type IconName } from '../../components/Icon';
import { CameraView, Choice, PRIORITY_NAME, PriorityBadge, StateChip } from '../../components/ui';
import { USERS } from '../../data/seed';
import type { Alert, Classification, QavachRecordType } from '../../data/types';
import { draftRecord } from '../../lib/qai';
import { ago, duration, hm, useNow } from '../../lib/time';
import { acknowledge, AREAS_BY_ID, isOpen, markFalse, raiseInQavach, roleText, TEAMS_BY_ID, useAlerts, useCameras, usePolicies, useRules, useSession } from '../../state/store';
import './phone.css';

// What a shift supervisor sees on the phone: the alert arrives as a push,
// they open it, acknowledge it, and report it into Qavach from the same page.

const SUPERVISORS = USERS.filter((u) => u.role === 'Shift supervisor');
type Page = 'home' | 'alerts' | 'reports' | 'menu';
const PAGES: Page[] = ['home', 'alerts', 'reports', 'menu'];
const TITLE: Record<Page, string> = { home: 'Dashboard', alerts: 'Alerts', reports: 'Raised in Qavach', menu: 'Features' };
const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2);

export function Phone() {
  const { alertId } = useParams();
  const nav = useNavigate();
  const { userId } = useSession();
  const [asId, setAsId] = useState(() => (SUPERVISORS.some((u) => u.id === userId) ? userId : SUPERVISORS[0].id));
  const [who, setWho] = useState(false);
  const as = USERS.find((u) => u.id === asId)!;
  const list = useMyAlerts(asId);
  const page: Page | null = PAGES.includes(alertId as Page) ? (alertId as Page) : alertId ? null : 'home';
  useEffect(() => {
    document.title = 'Safety alerts · Qavach';
  }, []);
  const open = list.filter(isOpen).length;
  const go = (p: Page) => nav(p === 'home' ? '/m' : `/m/${p}`);
  const switchTo = (id: string) => {
    setAsId(id);
    setWho(false);
  };
  return (
    <div className="phonepage">
      <div className="phonepage__side">
        <Logo size={34} />
        <h1>Supervisor's phone</h1>
        <p>This is what a shift supervisor gets on the Qavach app when an alert is sent to them. It stays in step with the console and the wall.</p>
        <Choice id="phone-as" label="Viewing As" value={asId} onChange={setAsId} options={SUPERVISORS.map((u) => ({ value: u.id, label: `${u.name} · ${TEAMS_BY_ID[u.teamId]?.name}` }))} />
      </div>
      <div className="phone" role="region" aria-label="Phone">
        <div className="phone__status">
          <span>{hm(Date.now())}</span>
          <span className="spacer" />
          <Icon name="wifi" size={14} />
          <span>5G</span>
        </div>
        <header className="phone__head">
          {page ? (
            <img src="/brand/logo-mark.png" alt="" className="phone__logo" />
          ) : (
            <button type="button" className="phone__icon" onClick={() => nav('/m/alerts')} aria-label="Back to alerts">
              <Icon name="chevron-left" size={26} stroke={2} />
            </button>
          )}
          <h1>{page ? TITLE[page] : alertId}</h1>
          <button type="button" className="phone__icon phone__bell" onClick={() => go('alerts')} aria-label={`${open} open alerts`}>
            <Icon name="bell" size={28} stroke={1.6} />
            {open > 0 && <span className="phone__badge">{open}</span>}
          </button>
          <button type="button" className="phone__icon" onClick={() => setWho(!who)} aria-label="Switch person" aria-expanded={who}>
            <Icon name="user" size={28} stroke={1.6} />
          </button>
        </header>
        {who && (
          <div className="phone__who" role="menu">
            <span className="phone__whohead">Viewing as</span>
            {SUPERVISORS.map((u) => (
              <button key={u.id} type="button" role="menuitemradio" aria-checked={u.id === asId} onClick={() => switchTo(u.id)}>
                <span className="phone__avatar">{initials(u.name)}</span>
                <span className="stack" style={{ gap: 0 }}>
                  <strong>{u.name}</strong>
                  <span>{TEAMS_BY_ID[u.teamId]?.name}</span>
                </span>
                {u.id === asId && <Icon name="check" size={20} stroke={2.4} />}
              </button>
            ))}
          </div>
        )}
        {page === 'home' && <PhoneHome as={as} list={list} go={go} />}
        {page === 'alerts' && <PhoneList list={list} />}
        {page === 'reports' && <PhoneReports list={list} />}
        {page === 'menu' && <PhoneMenu go={go} />}
        {!page && <PhoneAlert id={alertId!} userId={as.id} />}
        <nav className="phone__nav" aria-label="Phone">
          {(
            [
              ['home', 'home', 'Home'],
              ['alerts', 'warning', 'Alerts'],
              ['reports', 'shield', 'Raised in Qavach'],
              ['menu', 'menu', 'Menu'],
            ] as const
          ).map(([p, icon, label]) => (
            <button key={p} type="button" aria-label={label} aria-current={page === p ? 'page' : undefined} className={page === p || (!page && p === 'alerts') ? 'is-on' : ''} onClick={() => go(p)}>
              <Icon name={icon} size={30} stroke={1.6} />
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function useMyAlerts(userId: string) {
  const alerts = useAlerts();
  const cams = useCameras();
  const me = USERS.find((u) => u.id === userId)!;
  const areas = TEAMS_BY_ID[me.teamId]?.areaIds ?? [];
  return useMemo(() => {
    const camArea = new Map(cams.map((c) => [c.id, c.areaId]));
    // Alerts of a camera that has since been removed have nothing to show, and a camera that keeps firing (a looping
    // test clip) would bury the rest: one row per camera and kind of alert, the newest, and no more than 25 rows.
    const seen = new Set<string>();
    return alerts
      .filter((a) => camArea.has(a.cameraId) && (a.deliveries.some((d) => d.to === userId) || areas.includes(camArea.get(a.cameraId) ?? '')))
      .filter((a) => {
        const key = `${a.cameraId}|${a.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 25);
  }, [alerts, cams, userId, areas]);
}

/** One alert as a dark rounded card: level, title, where, when and its state. */
function AlertCard({ a }: { a: Alert }) {
  const cams = useCameras();
  const now = useNow(5000);
  const cam = cams.find((c) => c.id === a.cameraId);
  return (
    <Link to={`/m/${a.id}`} className="pcard pitem">
      {cam && (
        <span className="pitem__thumb">
          <CameraView cam={cam} still alert={a} caption={false} />
        </span>
      )}
      <span className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
        <span className="pitem__top">
          <PriorityBadge p={a.priority} short />
          <span className="pitem__time">{ago(a.at, now)}</span>
        </span>
        <span className="pitem__title">{a.title}</span>
        <span className="pitem__where">
          {cam?.name} · {AREAS_BY_ID[cam?.areaId ?? '']?.name}
        </span>
        <span className="pitem__state">
          <StateChip state={a.state} />
        </span>
      </span>
    </Link>
  );
}

function PhoneHome({ as, list, go }: { as: (typeof USERS)[number]; list: Alert[]; go: (p: Page) => void }) {
  const open = list.filter(isOpen);
  const needs = list.filter((a) => isOpen(a) || (a.state === 'acknowledged' && !a.qavach));
  return (
    <div className="phone__scroll">
      <div className="phone__tiles">
        <div className="pcard ptile">
          <span className="phone__avatar phone__avatar--lg">{initials(as.name)}</span>
          <strong>{as.name}</strong>
          <span className="ptile__sub">{as.role}</span>
          <span className="ptile__faint">{TEAMS_BY_ID[as.teamId]?.name}</span>
        </div>
        <button type="button" className="pcard ptile ptile--btn" onClick={() => go('alerts')}>
          <span className="ptile__label">Open alerts</span>
          <span className="ptile__big">{open.length}</span>
          <span className="ptile__sub">{needs.length} need you</span>
        </button>
      </div>
      <div className="pcard plevels">
        {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
          <div key={p} className="plevels__row">
            <span className={`plevels__swatch plevels__swatch--${p}`}>{p}</span>
            <span>{PRIORITY_NAME[p]}</span>
            <strong>{open.filter((a) => a.priority === p).length}</strong>
          </div>
        ))}
      </div>
      <div className="phone__section">
        <h2>Latest alerts</h2>
        <button type="button" onClick={() => go('alerts')}>
          See All
        </button>
      </div>
      {list.slice(0, 3).map((a) => (
        <AlertCard key={a.id} a={a} />
      ))}
      {list.length === 0 && <p className="phone__empty">Nothing needs you right now.</p>}
    </div>
  );
}

function PhoneList({ list }: { list: Alert[] }) {
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const shown = list.filter((a) => (tab === 'open' ? isOpen(a) || (a.state === 'acknowledged' && !a.qavach) : true));
  return (
    <>
      <div className="phone__tabs">
        <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
          Needs you
        </button>
        <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
          All
        </button>
      </div>
      <div className="phone__scroll">
        {shown.length === 0 && <p className="phone__empty">Nothing needs you right now.</p>}
        {shown.map((a) => (
          <AlertCard key={a.id} a={a} />
        ))}
      </div>
    </>
  );
}

function PhoneReports({ list }: { list: Alert[] }) {
  const now = useNow(5000);
  const done = list.filter((a) => a.qavach);
  return (
    <div className="phone__scroll">
      {done.length === 0 && <p className="phone__empty">Nothing raised in Qavach yet.</p>}
      {done.map((a) => (
        <Link key={a.id} to={`/m/${a.id}`} className="pcard preportrow">
          <span className="preportrow__type">
            <Icon name="shield" size={16} />
            {a.qavach!.type}
          </span>
          <strong>
            {a.qavach!.ref} · {a.qavach!.title}
          </strong>
          <span className="pitem__where">
            {a.qavach!.severity} · {a.qavach!.classification} · {ago(a.qavach!.at, now)}
          </span>
        </Link>
      ))}
    </div>
  );
}

function PhoneMenu({ go }: { go: (p: Page) => void }) {
  const rows: [Page, IconName, string][] = [
    ['home', 'home', 'Home'],
    ['alerts', 'warning', 'Alerts'],
    ['reports', 'shield', 'Raised in Qavach'],
  ];
  return (
    <div className="phone__scroll phone__scroll--menu">
      {rows.map(([p, icon, label]) => (
        <button key={p} type="button" className="pmenu" onClick={() => go(p)}>
          <Icon name={icon} size={30} stroke={1.5} />
          <span>{label}</span>
          <Icon name="chevron-right" size={22} stroke={2} />
        </button>
      ))}
    </div>
  );
}

function PhoneAlert({ id, userId }: { id: string; userId: string }) {
  const alerts = useAlerts();
  const cams = useCameras();
  const rules = useRules();
  const policies = usePolicies();
  const now = useNow(1000);
  const alert = alerts.find((a) => a.id === id);
  const cam = cams.find((c) => c.id === alert?.cameraId);
  const rule = rules.find((r) => r.id === alert?.ruleId);
  const policy = policies.find((p) => p.priority === alert?.priority);
  const [reporting, setReporting] = useState(false);

  if (!alert || !cam)
    return (
      <div className="phone__scroll">
        <p className="phone__empty">
          Alert not found. <Link to="/m/alerts">Back to alerts</Link>
        </p>
      </div>
    );

  const open = isOpen(alert);
  const due = policy ? alert.at + policy.ackWithinMin * 60000 - now : 0;

  return (
    <>
      <div className="phone__scroll">
        <div className={`pbanner pbanner--${alert.priority}`}>
          <span className="pbanner__p">
            {alert.priority} · {PRIORITY_NAME[alert.priority]}
          </span>
          <strong>{alert.title}</strong>
          <span>
            {cam.name} · {ago(alert.at, now)}
          </span>
          {open && policy && policy.escalateTo !== 'none' && alert.state === 'new' && <span className="pbanner__due">Escalates to the {roleText(policy.escalateTo)} in {duration(Math.max(0, due))}</span>}
          {alert.state === 'escalated' && <span className="pbanner__due">Escalated: not acknowledged in time</span>}
        </div>
        <CameraView cam={cam} still alert={alert} zones={cam.zones.filter((z) => z.id === alert.zoneId)} />
        <dl className="pfacts">
          <dt>What</dt>
          <dd>{alert.detail}</dd>
          <dt>Where</dt>
          <dd>
            {cam.id} · {AREAS_BY_ID[cam.areaId]?.name}
          </dd>
          <dt>Rule</dt>
          <dd>{rule?.name ?? alert.ruleId}</dd>
        </dl>

        {open && (
          <div className="pactions">
            <button
              type="button"
              className="pbtn pbtn--primary"
              onClick={() => {
                acknowledge(alert.id, userId, 'mobile');
                if (rule && rule.qavach !== 'none') setReporting(true);
              }}
            >
              <Icon name="check" size={20} stroke={2.2} />
              Acknowledge
            </button>
            <a className="pbtn" href="tel:+910000000000">
              <Icon name="phone" size={18} />
              Call control room
            </a>
            <button type="button" className="pbtn pbtn--ghost" onClick={() => markFalse(alert.id, userId, 'From the phone')}>
              False alarm
            </button>
          </div>
        )}

        {!open && alert.ackBy && (
          <p className="pnote">
            <Icon name="check" size={16} />
            Acknowledged by {USERS.find((u) => u.id === alert.ackBy)?.name ?? alert.ackBy} {alert.ackVia === 'mobile' ? 'on the phone' : alert.ackVia === 'wall' ? 'on the wall' : 'in the console'} at {hm(alert.ackAt!)}
          </p>
        )}

        {alert.qavach ? (
          <div className="pdone">
            <Icon name="shield" size={20} />
            <span>
              <strong>
                {alert.qavach.type} {alert.qavach.ref}
              </strong>{' '}
              is in Qavach with the snapshot and clip.
            </span>
          </div>
        ) : (
          alert.state === 'acknowledged' &&
          (reporting && cam ? (
            <PhoneReport alert={alert} userId={userId} onDone={() => setReporting(false)} />
          ) : (
            <button type="button" className="pbtn" onClick={() => setReporting(true)}>
              <Icon name="send" size={18} />
              Report in Qavach
            </button>
          ))
        )}
      </div>
    </>
  );
}

function PhoneReport({ alert, userId, onDone }: { alert: Alert; userId: string; onDone: () => void }) {
  const cams = useCameras();
  const rules = useRules();
  const cam = cams.find((c) => c.id === alert.cameraId)!;
  const rule = rules.find((r) => r.id === alert.ruleId);
  const d = draftRecord(alert, cam, rule, AREAS_BY_ID[cam.areaId], hm(alert.at));
  const [type, setType] = useState<QavachRecordType>(d.type);
  const [cls, setCls] = useState<Classification>(d.classification);
  const [note, setNote] = useState(d.immediateAction);
  return (
    <div className="preport">
      <strong>Report in Qavach</strong>
      <div className="phone__tabs phone__tabs--inline">
        {(['Incident', 'Near miss', 'Observation'] as QavachRecordType[]).map((t) => (
          <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="phone__tabs phone__tabs--inline">
        {(['Unsafe act', 'Unsafe condition'] as Classification[]).map((t) => (
          <button key={t} type="button" aria-pressed={cls === t} onClick={() => setCls(t)}>
            {t}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field__label">What you did</span>
        <textarea
          className="textarea"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <span className="meta">
        <Icon name="camera" size={14} /> Snapshot and 20 s clip from {cam.id} attached
      </span>
      <button
        type="button"
        className="pbtn pbtn--primary"
        onClick={() => {
          raiseInQavach(alert.id, { ...d, type, classification: cls, immediateAction: note, createdBy: userId, source: 'mobile' });
          onDone();
        }}
      >
        <Icon name="send" size={18} />
        Submit to Qavach
      </button>
    </div>
  );
}
