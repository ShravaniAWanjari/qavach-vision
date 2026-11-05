import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useService } from '../state/bridge';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { SITE, USERS } from '../data/seed';
import { resetAll, useStore } from '../lib/persist';
import { ago, hms, useNow } from '../lib/time';
import { isAdmin, isOpen, sessionStore, toast, toastStore, useAlerts, useCameras, useMe, useRules, useSession, userName } from '../state/store';
import { Icon, Logo, type IconName } from './Icon';
import { CHANNEL, PriorityBadge, useConfirm } from './ui';
import './Shell.css';

/** The module's own screens. In Qavach they sit under Autonomous Safety, QAI, CCTV Analyzer. */
const TABS: { to: string; label: string; end?: boolean; external?: boolean }[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/wall', label: 'Video wall' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/cameras', label: 'Cameras' },
  { to: '/rules', label: 'Rules' },
  { to: '/notifications', label: 'Notify' },
  { to: '#/m', label: 'Phone view', external: true },
];

const PAGE_NAMES: [string, string][] = [
  ['/wall', 'Video wall'],
  ['/alerts', 'Alerts'],
  ['/cameras', 'Cameras'],
  ['/rules', 'Rules'],
  ['/notifications', 'Notify'],
];

/** Qavach's left menu. Only Autonomous Safety leads anywhere in this demo. */
const SIDE: { label: string; icon: IconName; to?: string }[] = [
  { label: 'Home', icon: 'home' },
  { label: 'Dashboard', icon: 'dash' },
  { label: 'Management Report', icon: 'report' },
  { label: 'Autonomous Safety', icon: 'autonomous', to: '/' },
  { label: 'Risk Assessment', icon: 'risk' },
  { label: 'Unsafe Action', icon: 'unsafe' },
  { label: 'Observation', icon: 'observe' },
  { label: 'Incident Management', icon: 'incmgmt' },
  { label: 'Inspection', icon: 'inspect' },
];

const FLY: { label: string; icon: IconName }[] = [
  { label: 'Dashboard', icon: 'dash' },
  { label: 'UIN', icon: 'uin' },
  { label: 'Polaris', icon: 'compass' },
  { label: 'Analyzer', icon: 'analyzer' },
  { label: 'Intelligence', icon: 'intel' },
  { label: 'Listing', icon: 'listing' },
  { label: 'Review', icon: 'review' },
  { label: 'Inspection', icon: 'eye' },
  { label: 'RCA', icon: 'rca' },
  { label: 'Action Management', icon: 'wheel' },
  { label: 'Workflow', icon: 'workflow' },
  { label: 'Reports', icon: 'stack' },
  { label: 'Configuration', icon: 'config' },
];

const INTEL_MENU = ['Geo-Location Tracker', 'Heat Map', 'Hotspot Evolution', 'Live Operations Map', 'CCTV Analyzer'];

// Every menu entry that leads nowhere in this demo says the same thing, whichever one was clicked.
const notInDemo = (_what: string) => toast('Other modules of Qavach');

export function Shell() {
  const me = useMe();
  const [profile, setProfile] = useState(false);
  const [bell, setBell] = useState(false);

  return (
    <div className="app">
      <SideMenu />
      <TopBar onBell={() => setBell(true)} onProfile={() => setProfile((v) => !v)} />
      <div className="main">
        <main className="content">
          <ModuleTabs />
          <Outlet />
        </main>
      </div>
      <button type="button" className="polaris" onClick={() => notInDemo('Polaris')} aria-label="Polaris">
        <span>POLARIS</span>
        <Icon name="compass" size={22} />
      </button>

      {profile && <ProfileMenu onClose={() => setProfile(false)} />}
      {bell && <NotificationsDrawer onClose={() => setBell(false)} />}
      <Toasts />
      <span className="sr-only">Signed in as {me.name}, {me.role}</span>
    </div>
  );
}

function SideMenu() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [fly, setFly] = useState(false);
  const [intel, setIntel] = useState(false);
  const [flyTop, setFlyTop] = useState(240);
  const timer = useRef<number>(0);
  const close = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setFly(false);
    setIntel(false);
  };
  // A short grace period, so a pointer that leaves for a moment (or jumps to the menu) does not close it.
  const later = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, 220);
  };
  const keep = () => {
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  return (
    <>
      {open && <div className="side__scrim" onClick={close} />}
      <aside className={`side${open ? ' is-open' : ''}`} aria-label="Qavach" onMouseEnter={keep} onMouseMove={keep} onMouseLeave={later} onFocus={keep}>
        <Link to="/" className="side__logo" aria-label="Qavach">
          <Logo size={44} />
          <span className="side__brand">QAVACH</span>
        </Link>
        <nav className="side__nav">
          {SIDE.map((n) => {
            const active = n.label === 'Autonomous Safety';
            return (
              <button
                key={n.label}
                type="button"
                className={`side__item${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onMouseEnter={(e) => {
                  setFly(active);
                  if (active) setFlyTop(Math.max(96, e.currentTarget.getBoundingClientRect().top - 72));
                }}
                onClick={() => {
                  if (n.to) {
                    setFly((v) => !v);
                  } else if (n.label === 'Home') {
                    nav('/');
                    close();
                  } else notInDemo(n.label);
                }}
              >
                <Icon name={n.icon} size={26} stroke={1.5} />
                <span className="side__label">{n.label}</span>
                <Icon name={open && fly && active ? 'chevron-left' : 'chevron-right'} size={18} stroke={2.4} className="side__more" />
              </button>
            );
          })}
        </nav>
        {open && fly && (
          <div className="fly" style={{ top: flyTop }} role="menu" aria-label="Autonomous Safety">
            <div className="fly__grid">
              {FLY.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  className={`fly__tile${f.label === 'Intelligence' && intel ? ' is-on' : ''}`}
                  role="menuitem"
                  onMouseEnter={() => setIntel(f.label === 'Intelligence')}
                  onClick={() => (f.label === 'Intelligence' ? setIntel((v) => !v) : notInDemo(f.label))}
                >
                  <Icon name={f.icon} size={46} stroke={1.3} />
                  <span>{f.label}</span>
                  {f.label === 'Intelligence' && intel && (
                    <span className="fly__sub" role="menu" aria-label="Intelligence">
                      {INTEL_MENU.map((m) => (
                        <span
                          key={m}
                          role="menuitem"
                          tabIndex={0}
                          className={`fly__subitem${m === 'CCTV Analyzer' ? ' is-on' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (m === 'CCTV Analyzer') {
                              nav('/');
                              close();
                            } else notInDemo(m);
                          }}
                          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                        >
                          {m}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function ModuleTabs() {
  return (
    <nav className="mtabs" aria-label="CCTV Analyzer">
      {TABS.map((t) =>
        t.external ? (
          <a key={t.to} href={t.to} target="_blank" rel="noopener" className="mtabs__tab" title="Opens the supervisor's phone view in a new window">
            {t.label}
            <Icon name="external" size={14} />
          </a>
        ) : (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `mtabs__tab${isActive ? ' is-active' : ''}`}>
            {t.label}
          </NavLink>
        ),
      )}
    </nav>
  );
}

function TopBar({ onBell, onProfile }: { onBell: () => void; onProfile: () => void }) {
  const { live } = useSession();
  const me = useMe();
  const alerts = useAlerts();
  const now = useNow(1000);
  const service = useService();
  const { pathname } = useLocation();
  const mine = alerts.filter((a) => isOpen(a) && a.deliveries.some((d) => d.to === me.id)).length;
  const page = PAGE_NAMES.find(([p]) => pathname.startsWith(p))?.[1];
  const title = page ?? 'CCTV Analyzer';
  return (
    <header className="hdr">
      <div className="hdr__title">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <Icon name="chevron-right" size={14} stroke={2.4} />
          <span>QAI</span>
          <Icon name="chevron-right" size={14} stroke={2.4} />
          {page ? <Link to="/">CCTV Analyzer</Link> : <span className="is-last">CCTV Analyzer</span>}
          {page && (
            <>
              <Icon name="chevron-right" size={14} stroke={2.4} />
              <span className="is-last">{page}</span>
            </>
          )}
        </nav>
        <div className="hdr__h">{title}</div>
      </div>
      <Search />
      <span className="spacer" />
      <span className={`bar__service${service.online ? ' is-on' : ''}`} title={service.online ? 'Connected to the detection service: real cameras and rules run for real.' : 'The detection service is not running. Sample data only. Start it with ./start.sh or backend/run.sh.'}>
        <span className="bar__live-dot" />
        {service.online ? 'Detection on' : 'Detection offline'}
      </span>
      <button
        type="button"
        className={`bar__live${live ? '' : ' is-paused'}`}
        onClick={() => sessionStore.set((s) => ({ ...s, live: !s.live }))}
        title={live ? 'Live events are on: new alerts arrive every minute or so. Click to pause.' : 'Live events are paused. Click to resume.'}
      >
        <span className="bar__live-dot" />
        <span className="mono">{hms(now)}</span>
        <span>{live ? 'Live' : 'Paused'}</span>
      </button>
      <div className="hdr__icons">
        <button type="button" className="hdr__icon" aria-label="QAI assistant" title="QAI assistant" onClick={() => notInDemo('The QAI assistant')}>
          <Icon name="spark" size={26} stroke={1.5} />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Messages" title="Messages" onClick={() => notInDemo('Messages')}>
          <Icon name="chat" size={26} stroke={1.5} />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Support" title="Support" onClick={() => notInDemo('Support')}>
          <Icon name="headset" size={26} stroke={1.5} />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Language" title="Language" onClick={() => notInDemo('Language')}>
          <Icon name="translate" size={26} stroke={1.5} />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Mail" title="Mail" onClick={() => notInDemo('Mail')}>
          <Icon name="mail" size={26} stroke={1.5} />
        </button>
        <button type="button" className="hdr__icon" onClick={onBell} aria-label={`Notifications${mine ? `, ${mine} open alerts sent to you` : ''}`} title="Notifications">
          <Icon name="bell" size={26} stroke={1.5} />
          {mine > 0 && <span className="hdr__badge">{mine > 99 ? '99+' : mine}</span>}
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Help" title="Help" onClick={() => notInDemo('Help')}>
          <Icon name="help" size={26} stroke={1.8} />
        </button>
        <button type="button" className="hdr__icon hdr__opt hdr__yt" aria-label="Training videos" title="Training videos" onClick={() => notInDemo('Training videos')}>
          <Icon name="youtube" size={30} stroke={1.8} />
        </button>
        <button type="button" className="hdr__icon" aria-label="Account menu" title="Account and roles" onClick={onProfile}>
          <Icon name="power" size={26} stroke={1.8} />
        </button>
      </div>
      <button type="button" className="hdr__user" onClick={onProfile} aria-label={`Signed in as ${me.name}, ${me.role}`}>
        <span className="hdr__who">
          <strong>{me.name}</strong>
          <span>{me.role}</span>
        </span>
        <span className="hdr__avatar">
          {me.name
            .split(' ')
            .map((p) => p[0])
            .join('')}
        </span>
      </button>
    </header>
  );
}

function Search() {
  const cams = useCameras();
  const alerts = useAlerts();
  const rules = useRules();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const out: { to: string; icon: IconName; label: string; sub: string }[] = [];
    cams.filter((c) => `${c.id} ${c.name}`.toLowerCase().includes(t)).slice(0, 5).forEach((c) => out.push({ to: `/cameras/${c.id}`, icon: 'camera', label: `${c.id} · ${c.name}`, sub: 'Camera' }));
    alerts.filter((a) => `${a.id} ${a.title} ${a.qavach?.ref ?? ''}`.toLowerCase().includes(t)).slice(0, 4).forEach((a) => out.push({ to: `/alerts/${a.id}`, icon: 'bell', label: `${a.id} · ${a.title}`, sub: a.qavach ? `Alert · ${a.qavach.ref}` : 'Alert' }));
    rules.filter((r) => `${r.id} ${r.name}`.toLowerCase().includes(t)).slice(0, 4).forEach((r) => out.push({ to: `/rules/${r.id}`, icon: 'rule', label: `${r.id} · ${r.name}`, sub: 'Rule' }));
    return out;
  }, [q, cams, alerts, rules]);
  const go = (to: string) => {
    nav(to);
    setQ('');
    setOpen(false);
    ref.current?.blur();
  };
  return (
    <div className="bar__search">
      <Icon name="search" size={18} />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) go(results[0].to);
          if (e.key === 'Escape') setQ('');
        }}
        placeholder="Find a camera, alert, rule or Qavach record"
        aria-label="Find a camera, alert, rule or Qavach record"
      />
      {open && q.trim() && (
        <div className="bar__results" role="listbox">
          {results.length === 0 && <div className="bar__result muted">Nothing matches “{q}”.</div>}
          {results.map((r) => (
            <button key={r.to} type="button" className="bar__result" onMouseDown={(e) => e.preventDefault()} onClick={() => go(r.to)}>
              <Icon name={r.icon} size={17} />
              <span className="ellipsis">{r.label}</span>
              <span className="spacer" />
              <span className="meta">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { live } = useSession();
  const nav = useNavigate();
  const confirm = useConfirm();
  return (
    <>
      <div className="click-away" onClick={onClose} />
      <div className="profile" role="menu">
        <div className="profile__head">
          <strong>{me.name}</strong>
          <span>{me.role}</span>
          <span className="meta">{SITE.name}</span>
        </div>
        <div className="profile__label">Try another role</div>
        {USERS.map((u) => (
          <button
            key={u.id}
            type="button"
            role="menuitemradio"
            aria-checked={u.id === me.id}
            className="profile__item"
            onClick={() => {
              sessionStore.set((s) => ({ ...s, userId: u.id }));
              onClose();
            }}
          >
            <span className={`profile__radio${u.id === me.id ? ' is-on' : ''}`} />
            <span className="stack" style={{ gap: 0 }}>
              <span>{u.name}</span>
              <span className="meta">{u.role}</span>
            </span>
          </button>
        ))}
        <div className="profile__sep" />
        <button type="button" className="profile__item" role="menuitem" onClick={() => sessionStore.set((s) => ({ ...s, live: !s.live }))}>
          <Icon name={live ? 'pause' : 'play'} size={18} />
          {live ? 'Pause live events' : 'Resume live events'}
        </button>
        <button
          type="button"
          className="profile__item"
          role="menuitem"
          onClick={() =>
            confirm.ask(
              { title: 'Reset the prototype?', message: 'Cameras, zones, rules, walls and alerts go back to the sample data.', action: 'Reset sample data' },
              () => {
                const keepUser = me.id;
                resetAll();
                sessionStore.set((s) => ({ ...s, userId: keepUser }));
                onClose();
                nav('/');
              },
            )
          }
        >
          <Icon name="refresh" size={18} />
          Reset sample data
        </button>
        {confirm.dialog}
      </div>
    </>
  );
}

function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const alerts = useAlerts();
  const now = useNow(5000);
  const nav = useNavigate();
  const items = alerts
    .flatMap((a) => a.deliveries.filter((d) => d.to === me.id || isAdmin(me)).map((d) => ({ a, d })))
    .sort((x, y) => y.d.at - x.d.at)
    .slice(0, 40);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Notifications">
        <div className="modal__head">
          <div className="stack" style={{ gap: 2 }}>
            <h2>Notifications</h2>
            <span className="meta">{isAdmin(me) ? 'Everything sent from this site (you are the safety admin)' : `Sent to ${me.name}`}</span>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="notif">
          {items.length === 0 && <div className="empty">Nothing sent to you yet.</div>}
          {items.map(({ a, d }, i) => (
            <button
              key={`${a.id}-${i}`}
              type="button"
              className="notif__item"
              onClick={() => {
                nav(`/alerts/${a.id}`);
                onClose();
              }}
            >
              <PriorityBadge p={a.priority} short />
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <span className="ellipsis">
                  <strong>{a.title}</strong>
                </span>
                <span className="meta">
                  {a.id} · {d.reason === 'alert' ? '' : d.reason === 'escalation' ? 'Escalation · ' : 'Reminder · '}
                  {CHANNEL[d.channel].label} to {userName(d.to)} · {d.status}
                </span>
              </span>
              <span className="spacer" />
              <span className="meta" style={{ whiteSpace: 'nowrap' }}>
                {ago(d.at, now)}
              </span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

function Toasts() {
  const toasts = useStore(toastStore);
  const nav = useNavigate();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone ? ` toast--${t.tone}` : ''}`}>
          {t.tone === 'alert' && <Icon name="warning" size={18} />}
          <span>{t.text}</span>
          {t.link && (
            <button type="button" className="toast__link" onClick={() => nav(t.link!)}>
              Open
            </button>
          )}
          <button type="button" className="toast__x" aria-label="Dismiss" onClick={() => toastStore.set((s) => s.filter((x) => x.id !== t.id))}>
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Banner for set-up screens when the signed-in role can only look. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  const me = useMe();
  if (isAdmin(me)) return null;
  return (
    <div className="readonly">
      <Icon name="info" size={18} />
      <span>
        {children} You are signed in as <strong>{me.role}</strong>. Switch to <strong>Safety admin</strong> in the profile menu to make changes.
      </span>
    </div>
  );
}
