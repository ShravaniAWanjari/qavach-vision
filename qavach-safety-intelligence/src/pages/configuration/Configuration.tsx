import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { Icon, type IconName } from '../../components/Icon';
import { AlertConfigPanel } from '../Notifications';
import { CameraEditor } from '../cameras/CameraEditor';
import type { Wall } from '../../data/types';
import { isAdmin, useMe, useWalls } from '../../state/store';
import { EditPanel, newWall } from '../wall/VideoWall';
import { NewRulePanel } from '../rules/NewRulePanel';
import { RuleEditor } from '../rules/RuleEditor';
import './configuration.css';

const SECTIONS: { to: string; label: string; icon: IconName }[] = [
  { to: '/configuration/alerts', label: 'Alerts', icon: 'bell' },
  { to: '/configuration/rules', label: 'Rules', icon: 'rule' },
  { to: '/configuration/cameras', label: 'Camera Set-up', icon: 'cctv' },
  { to: '/configuration/walls', label: 'New Video Wall', icon: 'wall' },
];

/** Everything that is set up rather than watched: the alert levels, the rules and the cameras. The left panel picks one;
 *  the right-hand panel is that section's form. */
export function Configuration() {
  return (
    <div className="page page--wide cfg">
      <nav className="cfg__nav card" aria-label="Configuration">
        {SECTIONS.map((s) => (
          <NavLink key={s.to} to={s.to} className={({ isActive }) => `cfg__item${isActive ? ' is-active' : ''}`}>
            <Icon name={s.icon} size={22} stroke={1.6} />
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="cfg__panel card">
        <Outlet />
      </div>
    </div>
  );
}

export function AlertsSection() {
  return <AlertConfigPanel inline onClose={() => {}} />;
}

export function NewRuleSection() {
  const nav = useNavigate();
  return <NewRulePanel inline onClose={() => nav('/rules')} />;
}

export function RuleSection() {
  const { ruleId } = useParams();
  return <RuleEditor key={ruleId} />;
}

export function CameraSection() {
  const { cameraId } = useParams();
  return <CameraEditor key={cameraId ?? 'new'} />;
}

/** A new video wall: its name, its team and the cameras on it. How a wall rolls is set on the Video Wall page itself. */
export function WallSection() {
  const nav = useNavigate();
  const me = useMe();
  const walls = useWalls();
  const [draft, setDraft] = useState<Wall>(() => newWall(isAdmin(me) ? '' : me.teamId));
  return (
    <section className="cfgpanel">
      <div className="modal__head">
        <div className="stack" style={{ gap: 2 }}>
          <h2>New Video Wall</h2>
          <span className="meta">Name it, give it a team, and choose its cameras</span>
        </div>
      </div>
      <div className="modal__body cfgwall">
        <EditPanel draft={draft} setDraft={setDraft} saved={walls[0] ?? draft} onDone={() => nav('/wall')} />
      </div>
    </section>
  );
}
