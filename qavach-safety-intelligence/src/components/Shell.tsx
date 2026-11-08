import { useEffect, useRef, useState, type ReactNode } from 'react';
import { resyncService, useService } from '../state/bridge';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { SITE, USERS } from '../data/seed';
import { resetAll } from '../lib/persist';
import { AlertPopups } from './AlertPopups';
import { isAdmin, isOpen, sessionStore, toast, useAlerts, useMe, useSession } from '../state/store';
import { Icon, type IconName } from './Icon';
import { useConfirm } from './ui';
import './Shell.css';
import { assetUrl } from '../lib/assets';

// The header names the page, as Qavach does ("Listing", "New Incident"); the most specific match wins.
const PAGE_NAMES: [string, string][] = [
  ['/wall', 'Video Wall'],
  ['/alerts', 'Alerts'],
  ['/cameras/new', 'New Camera'],
  ['/cameras/', 'Camera Set-up'],
  ['/cameras', 'Cameras'],
  ['/rules/new', 'New Rule'],
  ['/rules/', 'Rule'],
  ['/rules', 'Rules'],
  ['/configuration', 'Configuration'],
];

const PARENTS: [string, string, string][] = [
  ['/cameras/', '/cameras', 'Cameras'],
  ['/rules/', '/rules', 'Rules'],
];

/** Qavach's left menu, with Qavach's own icons (public/qv). Only Autonomous Safety leads anywhere in this demo. */
const SIDE: { label: string; img?: string; icon?: IconName; to?: string; menu?: 'auto' | 'cv' }[] = [
  { label: 'Home', img: 'home' },
  { label: 'Dashboard', img: 'dashboard' },
  { label: 'Management Report', img: 'management-report' },
  { label: 'Autonomous Safety', img: 'autonomous-safety', menu: 'auto' },
  { label: 'Computer Vision Safety', img: 'computer-vision-safety', to: '/', menu: 'cv' },
  { label: 'Risk Assessment', img: 'risk-assessment' },
  { label: 'Unsafe Action', img: 'unsafe-action' },
  { label: 'Observation', img: 'observation' },
  { label: 'Incident Management', img: 'incident' },
  { label: 'Inspection', img: 'inspection' },
];

/** Computer Vision Safety's tiles: the CCTV module's screens, in the same tile layout as Qavach's other menus. */
const CV_TILES: { to: string; label: string; end?: boolean; external?: boolean; img?: string; icon?: IconName }[] = [
  { to: '/', label: 'Overview', end: true, img: 'dashboard' },
  { to: '/wall', label: 'Video Wall', icon: 'wall' },
  { to: '/alerts', label: 'Alerts', icon: 'bell' },
  { to: '/cameras', label: 'Cameras', icon: 'cctv' },
  { to: '/rules', label: 'Rules', icon: 'rule' },
  { to: '/configuration', label: 'Configuration', img: 'configuration' },
  { to: '#/m', label: 'Phone View', external: true, icon: 'mobile' },
];

/** Autonomous Safety's tiles, in Qavach's order. CCTV is this module, so it has no Qavach icon and keeps the drawn one. */
const FLY: { label: string; img?: string; icon?: IconName }[] = [
  { label: 'Dashboard', img: 'dashboard' },
  { label: 'UIN', img: 'uin' },
  { label: 'Polaris', img: 'polaris' },
  { label: 'Analyzer', img: 'analyzer' },
  { label: 'Intelligence', img: 'intelligence' },
  { label: 'New', img: 'new' },
  { label: 'Listing', img: 'listing' },
  { label: 'Review', img: 'review' },
  { label: 'Inspection', img: 'inspection' },
  { label: 'RCA', img: 'rca' },
  { label: 'Action Management', img: 'action-management' },
  { label: 'Workflow', img: 'workflow' },
  { label: 'Reports', img: 'reports' },
  { label: 'Configuration', img: 'configuration' },
];

const INTEL_MENU = ['Geo-Location Tracker', 'Heat Map', 'Hotspot Evolution', 'Live Operations Map'];

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
          <Outlet />
        </main>
      </div>
      <button type="button" className="polaris" onClick={() => notInDemo('Polaris')} aria-label="Polaris">
        <span>POLARIS</span>
        <Icon name="compass" size={22} />
      </button>

      {profile && <ProfileMenu onClose={() => setProfile(false)} />}
      {bell && <NotificationsDrawer onClose={() => setBell(false)} />}
      <AlertPopups />
      <span className="sr-only">Signed in as {me.name}, {me.role}</span>
    </div>
  );
}

const OPEN_MENU = 'qsi:open-autonomous-safety';

/** Where a tab's menu panel starts, as in Q-HSE: a menu whose tiles fit in one row sits level with its tab; a longer one
 *  starts a little above the tab and runs down. Tiles sit in 8 equal columns with 12px between them. */
const TILES_PER_ROW = 8;

function flyTopFor(menu: 'auto' | 'cv', tab: DOMRect): number {
  const tiles = menu === 'cv' ? CV_TILES.length : FLY.length;
  const rows = Math.ceil(tiles / TILES_PER_ROW);
  const panelH = 38 + rows * 102 + (rows - 1) * 12;
  const centre = tab.top + tab.height / 2;
  const top = rows === 1 ? centre - panelH / 2 - 14 : tab.top - 72;
  return Math.max(96, Math.min(top, window.innerHeight - panelH - 8));
}

function SideMenu() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  // The dim layer behind the sidebar: lighter while the sidebar is only hovered, darker once a menu tab is open, and about 20%
  // more see-through whenever the mouse is outside the window.
  const [away, setAway] = useState(false);
  useEffect(() => {
    const out = () => setAway(true);
    const back = () => setAway(false);
    document.documentElement.addEventListener('mouseleave', out);
    document.documentElement.addEventListener('mouseenter', back);
    return () => {
      document.documentElement.removeEventListener('mouseleave', out);
      document.documentElement.removeEventListener('mouseenter', back);
    };
  }, []);
  const [fly, setFly] = useState<'auto' | 'cv' | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const { pathname } = useLocation();
  const [flyTop, setFlyTop] = useState(240);
  const timer = useRef<number>(0);
  const close = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setFly(null);
    setSub(null);
  };
  // A short grace period, so a pointer that leaves for a moment (or jumps to the menu) does not close it.
  const later = () => {
    window.clearTimeout(timer.current);
    if (fly) return; // an open menu stays until a click on the dim layer (or a tile) closes it
    timer.current = window.setTimeout(close, 220);
  };
  const keep = () => {
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  // The breadcrumb's "Autonomous Safety" opens the same menu as its sidebar item.
  useEffect(() => {
    const show = () => {
      const item = document.querySelector('.side__item[data-menu="cv"]');
      window.clearTimeout(timer.current);
      setOpen(true);
      setFly('cv');
      if (item) setFlyTop(flyTopFor('cv', item.getBoundingClientRect()));
    };
    window.addEventListener(OPEN_MENU, show);
    return () => window.removeEventListener(OPEN_MENU, show);
  }, []);
  return (
    <>
      {open && <div className={`side__scrim${fly ? ' is-menu' : ''}${away ? ' is-away' : ''}`} onClick={close} />}
      <aside className={`side${open ? ' is-open' : ''}`} aria-label="Qavach" onMouseEnter={keep} onMouseMove={keep} onMouseLeave={later} onFocus={keep}>
        <Link to="/" className="side__logo" aria-label="Qavach">
          <img className="side__mark" src={assetUrl('brand/qhse-logo-mark.svg')} alt="" />
          <img className="side__wordmark" src={assetUrl('brand/qhse-logo-text.svg')} alt="" />
        </Link>
        <nav className="side__nav">
          {SIDE.map((n) => {
            // The selected tab is the one whose menu is open; with none open it is the module this page belongs to.
            const active = n.menu === (fly ?? 'cv');
            return (
              <button
                key={n.label}
                type="button"
                data-menu={n.menu}
                className={`side__item${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  if (n.menu) {
                    // A menu opens when its tab is clicked, as in Q-HSE; hovering only highlights.
                    setFlyTop(flyTopFor(n.menu, e.currentTarget.getBoundingClientRect()));
                    setFly((v) => (v === n.menu ? null : n.menu!));
                  } else if (n.label === 'Home') {
                    nav('/');
                    close();
                  } else notInDemo(n.label);
                }}
              >
                {n.img ? <img className="side__img" src={assetUrl(`qv/side/${n.img}.png`)} alt="" /> : <Icon name={n.icon!} size={30} stroke={1.4} className="side__img side__img--drawn" />}
                <span className="side__label">{n.label}</span>
                <Icon name={open && n.menu && fly === n.menu ? 'chevron-left' : 'chevron-right'} size={18} stroke={2.4} className="side__more" />
              </button>
            );
          })}
        </nav>
        {open && fly === 'cv' && (
          <div className="fly" style={{ top: flyTop }} role="menu" aria-label="Computer Vision Safety">
            <div className="fly__grid">
              {CV_TILES.map((t) => (
                <button
                  key={t.to}
                  type="button"
                  className={`fly__tile${!t.external && (t.end ? pathname === t.to : pathname.startsWith(t.to)) ? ' is-on' : ''}`}
                  role="menuitem"
                  title={t.external ? "Opens the supervisor's phone view in a new window" : undefined}
                  onClick={() => {
                    if (t.external) window.open(t.to, '_blank', 'noopener');
                    else nav(t.to);
                    close();
                  }}
                >
                  {t.img ? <img className="fly__img" src={assetUrl(`qv/fly/${t.img}.png`)} alt="" /> : <Icon name={t.icon!} size={42} stroke={1.3} className="fly__svg" />}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {open && fly === 'auto' && (
          <div className="fly" style={{ top: flyTop }} role="menu" aria-label="Autonomous Safety">
            <div className="fly__grid">
              {FLY.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  className={`fly__tile${f.label === sub ? ' is-on' : ''}`}
                  role="menuitem"
                  onMouseEnter={() => setSub(f.label === 'Intelligence' ? f.label : null)}
                  onClick={() => (f.label === 'Intelligence' ? setSub((v) => (v === f.label ? null : f.label)) : notInDemo(f.label))}
                >
                  {f.img ? <img className="fly__img" src={assetUrl(`qv/fly/${f.img}.png`)} alt="" /> : <Icon name={f.icon!} size={42} stroke={1.3} className="fly__svg" />}
                  <span>{f.label}</span>
                  {f.label === 'Intelligence' && sub === 'Intelligence' && (
                    <span className="fly__sub" role="menu" aria-label="Intelligence">
                      {INTEL_MENU.map((m) => (
                        <span
                          key={m}
                          role="menuitem"
                          tabIndex={0}
                          className="fly__subitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            notInDemo(m);
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

/** The top bar's icons are cut from Qavach's own bar (public/nav). h is the picture's height in the source, shown at 60%. */
/** The top bar's icons are Qavach's own files (public/qv/hdr), shown at the size Qavach shows them. */
const NAV: Record<string, [string, number, number]> = {
  ai: ['ai.svg', 21, 21],
  chat: ['chat.png', 25, 25],
  support: ['support.svg', 29, 28],
  language: ['language.png', 29, 20],
  mail: ['mail.png', 22, 22],
  bell: ['bell.svg', 25, 25],
  help: ['help.svg', 24, 24],
  videos: ['videos.svg', 25, 25],
  logout: ['logout.svg', 25, 25],
};
function NavIcon({ name }: { name: keyof typeof NAV }) {
  const [file, w, h] = NAV[name];
  return <img className="hdr__img" src={assetUrl(`qv/hdr/${file}`)} width={w} height={h} style={{ width: w, height: h }} alt="" />;
}

function TopBar({ onBell, onProfile }: { onBell: () => void; onProfile: () => void }) {
  const me = useMe();
  const alerts = useAlerts();
  const { pathname } = useLocation();
  const [out, setOut] = useState(false);
  const mine = alerts.filter((a) => isOpen(a) && a.deliveries.some((d) => d.to === me.id)).length;
  const page = PAGE_NAMES.find(([p]) => pathname.startsWith(p))?.[1];
  const title = page ?? 'Overview';
  // A page inside a section (a camera, a rule, an alert) gets that section as a crumb too.
  const parent = PARENTS.find(([p]) => pathname.startsWith(p));
  return (
    <header className="hdr">
      <div className="hdr__title">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <img className="crumbs__sep" src={assetUrl('qv/hdr/crumb.png')} alt="" />
          <button type="button" className="crumbs__link" onClick={() => window.dispatchEvent(new Event(OPEN_MENU))}>
            Computer Vision Safety
          </button>
          {parent && (
            <>
              <img className="crumbs__sep" src={assetUrl('qv/hdr/crumb.png')} alt="" />
              <Link to={parent[1]}>{parent[2]}</Link>
            </>
          )}
          <img className="crumbs__sep" src={assetUrl('qv/hdr/crumb.png')} alt="" />
          <span className="is-last">{title}</span>
        </nav>
        <div className="hdr__h">{title}</div>
      </div>
      <span className="spacer" />
      <div className="hdr__icons">
        <button type="button" className="hdr__icon" aria-label="QAI assistant" title="QAI Assistant" onClick={() => notInDemo('The QAI assistant')}>
          <NavIcon name="ai" />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Messages" title="Messages" onClick={() => notInDemo('Messages')}>
          <NavIcon name="chat" />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Support" title="Support" onClick={() => notInDemo('Support')}>
          <NavIcon name="support" />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Language" title="Language" onClick={() => notInDemo('Language')}>
          <NavIcon name="language" />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Mail" title="Mail" onClick={() => notInDemo('Mail')}>
          <NavIcon name="mail" />
        </button>
        <button type="button" className="hdr__icon" onClick={onBell} aria-label={`Notifications${mine ? `, ${mine} open alerts sent to you` : ''}`} title="Notifications">
          <NavIcon name="bell" />
          {mine > 0 && <span className="hdr__badge">{mine > 99 ? '99+' : mine}</span>}
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Help" title="Help" onClick={() => notInDemo('Help')}>
          <NavIcon name="help" />
        </button>
        <button type="button" className="hdr__icon hdr__opt" aria-label="Training videos" title="Training Videos" onClick={() => notInDemo('Training videos')}>
          <NavIcon name="videos" />
        </button>
        <button type="button" className="hdr__icon" aria-label="Logout menu" title="Logout" aria-haspopup="menu" aria-expanded={out} onClick={() => setOut((v) => !v)}>
          <NavIcon name="logout" />
          {out && (
            <>
              <span className="click-away" onClick={(e) => { e.stopPropagation(); setOut(false); }} />
              <span className="logout" role="menu">
                <span
                  role="menuitem"
                  tabIndex={0}
                  className="logout__item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOut(false);
                    toast('Logout is not part of this demo');
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                >
                  Logout
                </span>
              </span>
            </>
          )}
        </button>
      </div>
      <button type="button" className="hdr__user" onClick={onProfile} aria-label={`Signed in as ${me.name}, ${me.role}`}>
        <span className="hdr__who">
          <strong>{me.name}</strong>
          <span>{me.role}</span>
        </span>
        <span className="hdr__avatar" data-tip={me.name}>
          {me.name
            .split(' ')
            .map((p) => p[0])
            .join('')}
        </span>
      </button>
    </header>
  );
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const service = useService();
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
          <span className={`bar__service${service.online ? ' is-on' : ''}`} title={service.online ? 'Connected to the detection service: real cameras and rules run for real.' : 'The detection service is not running. Sample data only. Start it with ./start.sh or backend/run.sh.'}>
            <span className="bar__live-dot" />
            {service.online ? 'Detection on' : 'Detection offline'}
          </span>
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
                resyncService();
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

// The alerts panel Qavach's bell opens: action reviews and closures, repeated as you scroll.
type QNote = { title: string; id?: string; owner: string; source: string; closure?: boolean };
const NOTES: QNote[] = [
  { title: 'Action Review ACT/1026/7480', id: 'ACT/1026/7480', owner: 'Martin Debeloz', source: '' },
  { title: 'Action Review ACT/1026/7392', id: 'ACT/1026/7392', owner: 'Karthik M', source: 'OBR/1026/4429' },
  { title: 'Action Review ACT/1026/7457', id: 'ACT/1026/7457', owner: 'Karthik M', source: 'OBR/1026/4440' },
  { title: 'Action Close ACT/1026/7472', owner: 'Martin Debeloz', source: 'OBR/1026/4442', closure: true },
  { title: 'Action Review ACT/1026/7408', id: 'ACT/1026/7408', owner: 'Karthik M', source: '' },
];

function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const [rounds, setRounds] = useState(3);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <>
      <div className="qn-scrim" onClick={onClose} />
      <aside className="qn" role="dialog" aria-modal="true" aria-label="Alerts">
        <div className="qn__head">
          <span>2444 New Alert(s)</span>
          <button type="button" className="qn__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={24} stroke={1.8} />
          </button>
        </div>
        <label className="qn__all">
          <span>Select All</span>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        </label>
        <div
          className="qn__list"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) setRounds((n) => n + 2);
          }}
        >
          {Array.from({ length: rounds }, (_, r) =>
            NOTES.map((n, i) => (
              <article key={`${r}-${i}`} className={`qn__item${all ? ' is-picked' : ''}`}>
                <button type="button" className="qn__more" aria-label="More" onClick={() => notInDemo('Alert actions')}>
                  <span className="qn__dots" />
                </button>
                <h3>{n.title}</h3>
                <p>
                  {n.closure ? (
                    <>
                      This is a notification regarding an <strong>assigned action closure</strong> for below action details.
                    </>
                  ) : (
                    'Please find the below details of the Action.'
                  )}
                </p>
                <p className="qn__facts">
                  Action ID: {n.id ? <a href={`#/${n.id}`} onClick={(e) => e.preventDefault()}>{n.id}</a> : '<>'}
                  <br />
                  Action Owner: {n.owner}
                  <br />
                  Source Event ID: {n.source}
                </p>
                {n.closure && <p>If there are any issues or delays, kindly escalate the matter to the reporting manager,</p>}
              </article>
            )),
          )}
        </div>
      </aside>
    </>
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
