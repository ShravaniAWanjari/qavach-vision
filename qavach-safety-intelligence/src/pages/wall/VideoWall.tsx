import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AckDialog } from '../../components/AlertDialogs';
import { Icon, Logo } from '../../components/Icon';
import { CameraView, Choice, Empty, Modal, PriorityBadge, Seg, StateChip, Switch, useConfirm } from '../../components/ui';
import { AREAS, TEAMS } from '../../data/seed';
import type { Alert, Camera, PinnedLayout, Wall } from '../../data/types';
import { uid } from '../../lib/persist';
import { ago, hms, useNow } from '../../lib/time';
import { AREAS_BY_ID, deleteWall, isAdmin, isOpen, saveWall, TEAMS_BY_ID, toast, useActivity, useAlerts, useCameras, useMe, useWalls } from '../../state/store';
import { LAYOUT_SLOTS, useWallModel, WallBody } from './WallBody';

const LAYOUTS: { value: PinnedLayout; label: string }[] = [
  { value: '1', label: '1' },
  { value: '2x2', label: '2 × 2' },
  { value: '1+5', label: '1 + 5' },
  { value: '2x3', label: '2 × 3' },
  { value: '3x3', label: '3 × 3' },
];

function useVisibleWalls() {
  const walls = useWalls();
  const me = useMe();
  return me.teamId === 't-hse' || isAdmin(me) ? walls : walls.filter((w) => w.teamId === me.teamId);
}

export function VideoWall() {
  const { wallId } = useParams();
  const nav = useNavigate();
  const me = useMe();
  const cams = useCameras();
  const visible = useVisibleWalls();
  const saved = visible.find((w) => w.id === wallId) ?? visible.find((w) => w.teamId === me.teamId) ?? visible[0];
  const [draft, setDraft] = useState<Wall | null>(null);
  const alerts = useAlerts();
  const [ack, setAck] = useState<Alert>();
  const [focus, setFocus] = useState<Camera>();
  const [settings, setSettings] = useState(false);

  useEffect(() => setDraft(null), [saved?.id]);

  const wall = draft ?? saved;
  const modelWall = useMemo(() => (wall && draft ? { ...wall, alertTakeover: false, autoPinBusy: false } : wall), [wall, draft]);
  const model = useWallModel(modelWall ?? EMPTY_WALL, !!draft);

  if (!saved || !wall) {
    return (
      <div className="page">
        <Empty icon="wall" title="No video wall for your team yet">
          Ask the safety admin to set one up.
        </Empty>
      </div>
    );
  }

  const update = (patch: Partial<Wall>) => {
    if (draft) setDraft({ ...draft, ...patch });
    else saveWall({ ...saved, ...patch });
  };

  const pinToggle = (cam: Camera, isPinned: boolean) => {
    const slots = LAYOUT_SLOTS[wall.pinnedLayout];
    const pinned = [...wall.pinned];
    if (isPinned) {
      const i = pinned.indexOf(cam.id);
      if (i >= 0) pinned[i] = null;
      update({ pinned, rotation: wall.rotation.includes(cam.id) ? wall.rotation : [cam.id, ...wall.rotation] });
      toast(`${cam.id} ${cam.name} unpinned; it rolls with the others now`);
      return;
    }
    if (wall.pinnedShare === 0) update({ pinnedShare: 70 });
    let i = pinned.slice(0, slots).findIndex((p) => !p);
    if (i < 0 && pinned.length < slots) i = pinned.length;
    let replaced: string | null = null;
    if (i < 0) {
      i = slots - 1;
      replaced = pinned[i];
    }
    while (pinned.length <= i) pinned.push(null);
    pinned[i] = cam.id;
    update({ pinned });
    toast(replaced ? `${cam.id} pinned in place of ${replaced}` : `${cam.id} ${cam.name} pinned to ${wall.name}`);
  };

  const newWall = () => {
    const team = TEAMS_BY_ID[me.teamId];
    const w: Wall = {
      id: uid('w'),
      name: `${team.name} · new`,
      teamId: team.id,
      pinnedShare: 70,
      pinnedLayout: '2x2',
      pinned: [],
      rollingTiles: 3,
      rotation: cams.filter((c) => team.areaIds.includes(c.areaId)).map((c) => c.id),
      rotateSec: 10,
      autoPinBusy: false,
      alertTakeover: true,
    };
    saveWall(w);
    nav(`/wall/${w.id}`);
    window.setTimeout(() => setDraft(w), 0);
  };


  return (
    <div className="wallpage">
      <div className="wallpage__head">
        <div className="walltabs" role="tablist" aria-label="Walls">
          {visible.map((w) => (
            <button key={w.id} type="button" role="tab" aria-selected={w.id === saved.id} onClick={() => nav(`/wall/${w.id}`)}>
              {w.name}
              {w.teamId === me.teamId && <span className="walltabs__mine">Your team</span>}
            </button>
          ))}
          <button type="button" className="walltabs__new" onClick={newWall} title="New wall for your team">
            <Icon name="plus" size={16} />
            New wall
          </button>
        </div>
        <div className="page__actions">
          <CastMenu />
          {!draft && (
            <button type="button" className="btn btn--secondary btn--icon" onClick={() => setDraft(saved)} title="Choose cameras" aria-label="Choose cameras">
              <Icon name="camera-plus" size={22} />
            </button>
          )}
          <button type="button" className={`btn btn--secondary btn--icon${settings ? ' is-on' : ''}`} onClick={() => setSettings((v) => !v)} title="Wall settings" aria-label="Wall settings" aria-pressed={settings}>
            <span className="qgear" aria-hidden="true" />
          </button>
          <button type="button" className="btn btn--secondary btn--icon" onClick={() => window.open(`#/screen/${saved.id}`, `qsi-wall-${saved.id}`, 'popup,width=1600,height=900')} title="Pop out: open this wall in its own window for a second monitor" aria-label="Pop out">
            <Icon name="external" size={20} />
          </button>
        </div>
      </div>

      <div className="wallpage__body">
        {draft && <EditPanel draft={draft} setDraft={setDraft} saved={saved} onDone={() => setDraft(null)} />}
        <div className="wallpage__wall">
          <WallBody
            wall={modelWall!}
            model={model}
            editing={!!draft}
            onAlert={(a) => nav(cameraAlerts(alerts, a.cameraId))}
            onOpen={setFocus}
            onPinToggle={pinToggle}
            onDropCam={(slot, id) => {
              const pinned = [...wall.pinned];
              const prev = pinned.indexOf(id);
              if (prev >= 0) pinned[prev] = null;
              while (pinned.length <= slot) pinned.push(null);
              pinned[slot] = id;
              update({ pinned });
            }}
            onClearSlot={(slot) => {
              const pinned = [...wall.pinned];
              pinned[slot] = null;
              update({ pinned });
            }}
            height="100%"
          />
        </div>
        {settings && !draft && <SettingsPanel wall={wall} update={update} model={model} onClose={() => setSettings(false)} />}
      </div>

      {ack && <AckDialog alert={ack} via="wall" onClose={() => setAck(undefined)} />}
      {focus && <FocusModal cam={focus} wall={wall} onPinToggle={pinToggle} onClose={() => setFocus(undefined)} onAck={(a) => setAck(a)} />}
    </div>
  );
}

/** The Alerts page filtered to one camera, with that camera's latest alert open. */
function cameraAlerts(alerts: Alert[], cameraId: string) {
  const latest = alerts.filter((a) => a.cameraId === cameraId).sort((x, y) => y.at - x.at)[0];
  return `/alerts${latest ? `/${latest.id}` : ''}?camera=${encodeURIComponent(cameraId)}`;
}

const EMPTY_WALL: Wall = { id: '-', name: '', teamId: 't-hse', pinnedShare: 70, pinnedLayout: '2x2', pinned: [], rollingTiles: 3, rotation: [], rotateSec: 10, autoPinBusy: false, alertTakeover: false };

function SettingsPanel({ wall, update, model, onClose }: { wall: Wall; update: (patch: Partial<Wall>) => void; model: ReturnType<typeof useWallModel>; onClose: () => void }) {
  const solo = wall.pinnedShare === 0;
  return (
    <aside className="wedit wset" aria-label="Wall settings">
      <div className="wedit__head wset__head">
        <h2>Wall settings</h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="wset__body">
        <div className="wset__group">
          <span className="walltools__label">Pinned vs rolling</span>
          <Seg
            label="Pinned versus rolling share"
            small
            value={wall.pinnedShare}
            onChange={(v) => update({ pinnedShare: v, rollingTiles: v === 0 ? 9 : v === 100 ? wall.rollingTiles : wall.rollingTiles > 6 ? 3 : wall.rollingTiles })}
            options={[
              { value: 100, label: 'All pinned' },
              { value: 80, label: '80 / 20' },
              { value: 70, label: '70 / 30' },
              { value: 60, label: '60 / 40' },
              { value: 0, label: 'All rolling' },
            ]}
          />
        </div>
        {!solo && (
          <div className="wset__group">
            <span className="walltools__label">Pinned grid</span>
            <Seg label="Pinned grid" small value={wall.pinnedLayout} onChange={(v) => update({ pinnedLayout: v })} options={LAYOUTS} />
          </div>
        )}
        {wall.pinnedShare !== 100 && (
          <>
            <div className="wset__group">
              <span className="walltools__label">Rolling tiles</span>
              <Seg
                label="Rolling tiles"
                small
                value={wall.rollingTiles}
                onChange={(v) => update({ rollingTiles: v })}
                options={(solo ? [4, 9, 16] : [3, 4, 6]).map((n) => ({ value: n as Wall['rollingTiles'], label: String(n) }))}
              />
            </div>
            <div className="wset__group">
              <span className="walltools__label">Next set every</span>
              <Seg label="Rotation interval" small value={wall.rotateSec} onChange={(v) => update({ rotateSec: v })} options={[10, 15, 30, 60].map((n) => ({ value: n as Wall['rotateSec'], label: `${n} s` }))} />
            </div>
          </>
        )}
        <div className="wset__group">
          <Switch checked={wall.alertTakeover} onChange={(v) => update({ alertTakeover: v })} label="Alerts take over a tile" />
          {!solo && <Switch checked={wall.autoPinBusy} onChange={(v) => update({ autoPinBusy: v })} label="Auto-pin the busiest camera" />}
        </div>
        {wall.pinnedShare !== 100 && (
          <span className="meta">
            Rolling set {model.page + 1} of {model.pages} · {model.pool.length} cameras
            {` · next in ${model.secsLeft} s`}
          </span>
        )}
      </div>
    </aside>
  );
}

function EditPanel({ draft, setDraft, saved, onDone }: { draft: Wall; setDraft: (w: Wall) => void; saved: Wall; onDone: () => void }) {
  const cams = useCameras();
  const walls = useWalls();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const team = TEAMS_BY_ID[draft.teamId];
  const slots = draft.pinnedShare === 0 ? 0 : LAYOUT_SLOTS[draft.pinnedLayout];
  const inScope = cams.filter((c) => (team?.areaIds ?? []).includes(c.areaId));
  const t = q.trim().toLowerCase();
  const list = inScope.filter((c) => !t || `${c.id} ${c.name}`.toLowerCase().includes(t));
  const pinnedSet = new Set(draft.pinned.slice(0, slots).filter(Boolean));
  const rot = new Set(draft.rotation);

  const pin = (id: string) => {
    const pinned = [...draft.pinned];
    let i = pinned.slice(0, slots).findIndex((p) => !p);
    if (i < 0 && pinned.length < slots) i = pinned.length;
    if (i < 0) {
      toast('All pinned slots are in use. Remove one, or pick a bigger grid.');
      return;
    }
    while (pinned.length <= i) pinned.push(null);
    pinned[i] = id;
    setDraft({ ...draft, pinned });
  };

  return (
    <aside className="wedit" aria-label="Choose cameras">
      <div className="wedit__head">
        <div className="field">
          <label htmlFor="wall-name">Wall name</label>
          <input id="wall-name" className="input input--sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="wall-team">Assigned Team</label>
          <Choice
            id="wall-team"
            small
            label="Assigned Team"
            value={draft.teamId}
            disabled={!isAdmin(me)}
            onChange={(teamId) => {
              const tm = TEAMS_BY_ID[teamId];
              setDraft({ ...draft, teamId: tm.id, pinned: [], rotation: cams.filter((c) => tm.areaIds.includes(c.areaId)).map((c) => c.id) });
            }}
            options={TEAMS.map((tm) => ({ value: tm.id, label: tm.name }))}
          />
        </div>
        <p className="meta">Drag a camera onto a pinned slot, or use Pin. Untick “Rolls” to leave a camera off this wall.</p>
        <input className="input input--sm" placeholder="Filter cameras" aria-label="Filter cameras" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row meta">
          <span>
            {pinnedSet.size} of {slots} pinned · {draft.rotation.filter((id) => !pinnedSet.has(id)).length} rolling
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft({ ...draft, rotation: inScope.map((c) => c.id) })}>
            All roll
          </button>
        </div>
      </div>
      <div className="wedit__list">
        {AREAS.filter((a) => team?.areaIds.includes(a.id)).map((a) => {
          const items = list.filter((c) => c.areaId === a.id);
          if (!items.length) return null;
          return (
            <div key={a.id}>
              <div className="wedit__area">
                {a.name}
                {a.highOps && <span className="chip chip--outline">High-operational</span>}
              </div>
              {items.map((c) => (
                <div key={c.id} className="wedit__cam" draggable onDragStart={(e) => e.dataTransfer.setData('text/camera', c.id)}>
                  <Icon name="drag" size={16} className="faint" />
                  <span className={`dot dot--${c.status}`} />
                  <span className="stack" style={{ gap: 0, minWidth: 0, flex: 1 }}>
                    <span className="ellipsis">
                      <span className="mono">{c.id}</span> {c.name}
                    </span>
                  </span>
                  {pinnedSet.has(c.id) ? (
                    <span className="chip chip--ai">Pinned</span>
                  ) : (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => pin(c.id)} disabled={!slots}>
                      <Icon name="pin" size={14} />
                      Pin
                    </button>
                  )}
                  <label className="check" title="Include in the rolling section">
                    <input type="checkbox" checked={rot.has(c.id)} onChange={(e) => setDraft({ ...draft, rotation: e.target.checked ? [...draft.rotation, c.id] : draft.rotation.filter((x) => x !== c.id) })} />
                    <span className="meta">Rolls</span>
                  </label>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {confirm.dialog}
      <div className="wedit__foot">
        {walls.length > 1 && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              confirm.ask({ title: 'Delete this wall?', message: `“${saved.name}” is removed for everyone on its team.`, action: 'Delete wall' }, () => {
                deleteWall(saved.id);
                onDone();
                nav('/wall');
              })
            }
          >
            <Icon name="trash" size={15} />
            Delete wall
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn--secondary btn--sm" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            saveWall(draft);
            toast(`${draft.name} saved. Everyone on ${team?.name} sees the new layout.`);
            onDone();
          }}
        >
          Save wall
        </button>
      </div>
    </aside>
  );
}

function FocusModal({ cam, wall, onClose, onPinToggle, onAck }: { cam: Camera; wall: Wall; onClose: () => void; onPinToggle: (c: Camera, pinned: boolean) => void; onAck: (a: Alert) => void }) {
  const alerts = useAlerts().filter((a) => a.cameraId === cam.id);
  const activity = useActivity();
  const now = useNow(1000);
  const [zones, setZones] = useState(true);
  const open = alerts.find(isOpen);
  const pinned = wall.pinned.includes(cam.id);
  return (
    <Modal title={`${cam.id} · ${cam.name}`} wide onClose={onClose}>
      <div className="focus">
        <div className="stack">
          <CameraView cam={cam} alert={open} zones={zones ? cam.zones : undefined} showZoneLabels={zones} now={now} />
          <div className="row-wrap">
            <Switch checked={zones} onChange={setZones} label={`Show zones (${cam.zones.length})`} />
            <span className="spacer" />
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onPinToggle(cam, pinned)}>
              <Icon name={pinned ? 'unpin' : 'pin'} size={15} />
              {pinned ? 'Unpin from this wall' : 'Pin to this wall'}
            </button>
            <Link to={`/cameras/${cam.id}`} className="btn btn--secondary btn--sm">
              <Icon name="camera" size={15} />
              Camera set-up
            </Link>
            {open && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  onClose();
                  onAck(open);
                }}
              >
                Acknowledge {open.id}
              </button>
            )}
          </div>
        </div>
        <div className="stack">
          <dl className="kv">
            <dt>Area</dt>
            <dd>{AREAS_BY_ID[cam.areaId]?.name}</dd>
            <dt>Status</dt>
            <dd className="row">
              <span className={`dot dot--${cam.status}`} />
              {cam.status}
            </dd>
            <dt>In view now</dt>
            <dd>{activity[cam.id] ?? 0} people and vehicles</dd>
            <dt>Clock</dt>
            <dd className="mono">{hms(now)}</dd>
          </dl>
          <h3>Alerts on this camera</h3>
          {alerts.length === 0 && <span className="meta">None yet.</span>}
          {alerts.slice(0, 6).map((a) => (
            <Link key={a.id} to={`/alerts/${a.id}`} className="focus__alert" onClick={onClose}>
              <PriorityBadge p={a.priority} short />
              <span className="ellipsis" style={{ flex: 1 }}>
                {a.title}
              </span>
              <StateChip state={a.state} />
              <span className="meta">{ago(a.at, now)}</span>
            </Link>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** The wall on its own, for a second monitor. Stays in step with the console. */
export function WallScreen() {
  const { wallId } = useParams();
  const walls = useWalls();
  const wall = walls.find((w) => w.id === wallId) ?? walls[0];
  const model = useWallModel(wall ?? EMPTY_WALL, false);
  const now = useNow(1000);
  const alerts = useAlerts();
  useEffect(() => {
    document.title = `${wall?.name ?? 'Wall'} · Safety Intelligence`;
  }, [wall?.name]);
  if (!wall) return null;
  return (
    <div className="wallscreen">
      <div className="wallscreen__bar">
        <Logo size={24} />
        <strong>{wall.name}</strong>
        <span className="muted">{TEAMS_BY_ID[wall.teamId]?.name}</span>
        <span className="spacer" />
        {model.scopeAlerts.length > 0 ? (
          <span className="chip chip--danger">{model.scopeAlerts.length} open alerts</span>
        ) : (
          <span className="chip chip--good">No open alerts</span>
        )}
        <span className="mono">{hms(now)}</span>
      </div>
      <WallBody
        wall={wall}
        model={model}
        onAlert={(a) => {
          // The pop-out sits on a second monitor: show the alerts in the console window that opened it.
          const to = `#${cameraAlerts(alerts, a.cameraId)}`;
          if (window.opener && !window.opener.closed) {
            window.opener.location.hash = to;
            window.opener.focus();
          } else window.location.hash = to;
        }}
        height="calc(100vh - 44px)"
      />
    </div>
  );
}

/** The Cast to display button: its menu lists what can be done with it; for now one option, Cast to display. */
function CastMenu() {
  const [open, setOpen] = useState(false);
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
  return (
    <div className="castmenu" ref={ref}>
      <button type="button" className={`btn btn--secondary btn--icon${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} title="Cast to display" aria-label="Cast to display" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="cast" size={22} />
      </button>
      {open && (
        <div className="castmenu__menu" role="menu">
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>
            <Icon name="cast" size={20} />
            Cast to display
          </button>
        </div>
      )}
    </div>
  );
}
