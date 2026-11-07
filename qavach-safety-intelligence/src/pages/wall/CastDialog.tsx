import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Choice, Modal, Switch } from '../../components/ui';
import type { Wall } from '../../data/types';
import { saveDisplay, useDisplays, type Display } from '../../state/displays';
import { TEAMS_BY_ID, toast, useWalls } from '../../state/store';
import './cast.css';

const WALL_TONES = ['var(--c-blue)', 'var(--c-green)', 'var(--c-violet)', 'var(--c-orange)', 'var(--c-brown)', 'var(--c-blue-dark)'];
const UNTIL: { value: Display['until']; label: string }[] = [
  { value: 'never', label: 'Keep until changed' },
  { value: 'shift', label: 'At the end of the shift' },
  { value: '1h', label: 'In 1 hour' },
  { value: '4h', label: 'In 4 hours' },
];

/**
 * Cast video walls to the screens in a room. Pick a display, then drag a wall from the left onto its screens (or click
 * screens, then click a wall). Different walls on one display show side by side; screens next to each other with the
 * same wall join into one picture. Nothing changes on the display until Cast.
 */
export function CastDialog({ currentWallId, onClose }: { currentWallId?: string; onClose: () => void }) {
  const walls = useWalls();
  const displays = useDisplays();
  const [displayId, setDisplayId] = useState(() => displays.find((d) => d.online)?.id ?? displays[0].id);
  const saved = displays.find((d) => d.id === displayId)!;
  const [draft, setDraft] = useState<Display>(saved);
  const [picked, setPicked] = useState<number[]>([]);
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const tone = (wallId: string | null) => (wallId ? WALL_TONES[Math.max(0, walls.findIndex((w) => w.id === wallId)) % WALL_TONES.length] : undefined);
  const wallName = (wallId: string | null) => walls.find((w) => w.id === wallId)?.name ?? 'Nothing';
  const pick = (id: string) => {
    setDisplayId(id);
    setDraft(displays.find((d) => d.id === id)!);
    setPicked([]);
  };
  const assign = (screens: number[], wallId: string | null) => setDraft((d) => ({ ...d, screens: d.screens.map((w, i) => (screens.includes(i) ? wallId : w)) }));
  const all = draft.screens.map((_, i) => i);
  const used = draft.screens.filter(Boolean).length;
  const inUse = [...new Set(draft.screens.filter(Boolean))] as string[];
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  // A screen joins its right or lower neighbour when both show the same wall: one picture across them.
  const joinRight = (i: number) => (i + 1) % draft.cols !== 0 && !!draft.screens[i] && draft.screens[i] === draft.screens[i + 1];
  const joinDown = (i: number) => i + draft.cols < draft.screens.length && !!draft.screens[i] && draft.screens[i] === draft.screens[i + draft.cols];

  const clickWall = (w: Wall) => {
    if (!draft.online) return;
    assign(picked.length ? picked : all, w.id);
    setPicked([]);
  };
  const cast = () => {
    saveDisplay(draft);
    toast(used ? `${draft.room} · ${draft.name}: ${inUse.map(wallName).join(' + ')} on ${used} of ${draft.screens.length} screens` : `${draft.room} · ${draft.name} cleared`);
    onClose();
  };

  const rooms = [...new Set(displays.map((d) => d.room))];
  return (
    <Modal
      title="Cast to a display"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cast__summary">
            {draft.online ? (used ? `${used} of ${draft.screens.length} screens · ${inUse.length > 1 ? `${inUse.length} walls combined` : wallName(inUse[0])}` : 'No screens chosen') : `${draft.name} is offline`}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!draft.online || !changed} onClick={cast}>
            <Icon name="cast" size={18} />
            {used ? `Cast to ${draft.name}` : `Clear ${draft.name}`}
          </button>
        </>
      }
    >
      <div className="cast">
        <aside className="cast__walls" aria-label="Video walls">
          <span className="cast__label">Video walls</span>
          <p className="meta cast__hint">Drag a wall onto the screens, or select screens and click a wall.</p>
          {walls.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`castwall${w.id === currentWallId ? ' is-current' : ''}`}
              draggable={draft.online}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/wall', w.id);
                setDragging(true);
              }}
              onDragEnd={() => setDragging(false)}
              onClick={() => clickWall(w)}
              disabled={!draft.online}
              title={picked.length ? `Show On The ${picked.length} Selected Screens` : 'Show On The Whole Display'}
            >
              <i style={{ background: tone(w.id) }} />
              <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                <strong className="ellipsis">{w.name}</strong>
                <span className="meta ellipsis">
                  {TEAMS_BY_ID[w.teamId]?.name ?? 'No team'} · {new Set([...w.pinned.filter(Boolean), ...w.rotation]).size} cameras
                </span>
              </span>
              <Icon name="drag" size={16} className="castwall__grip" />
            </button>
          ))}
          <button
            type="button"
            className="castwall castwall--clear"
            draggable={draft.online}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/wall', '');
              setDragging(true);
            }}
            onDragEnd={() => setDragging(false)}
            onClick={() => {
              assign(picked.length ? picked : all, null);
              setPicked([]);
            }}
            disabled={!draft.online}
          >
            <i />
            <span className="stack" style={{ gap: 0 }}>
              <strong>Nothing</strong>
              <span className="meta">Clears a screen</span>
            </span>
          </button>
        </aside>

        <div className="cast__main">
          <div className="cast__top">
            <Choice
              id="cast-display"
              label="Display"
              className="cast__pick"
              value={displayId}
              onChange={pick}
              options={rooms.flatMap((r) => displays.filter((d) => d.room === r).map((d) => ({ value: d.id, label: `${r} · ${d.name}${d.online ? '' : ' (offline)'}` })))}
            />
            <span className={`cast__status${draft.online ? '' : ' is-off'}`}>
              <i />
              {draft.online ? `Online · ${draft.cols} × ${draft.rows} · ${draft.size}` : 'Offline'}
            </span>
          </div>

          {draft.online ? (
            <>
              <div className="cast__tools">
                <span className="meta">{picked.length ? `${picked.length} screen${picked.length === 1 ? '' : 's'} selected` : 'Click screens to select them'}</span>
                <span className="spacer" />
                <button type="button" className="linkbtn" onClick={() => setPicked(picked.length === all.length ? [] : all)}>
                  {picked.length === all.length ? 'Select none' : 'Select all'}
                </button>
                <button type="button" className="linkbtn" onClick={() => assign(all, null)} disabled={!used}>
                  Clear all
                </button>
              </div>
              <div className={`castgrid${dragging ? ' is-dragging' : ''}`} style={{ gridTemplateColumns: `repeat(${draft.cols}, minmax(0, 1fr))` }}>
                {draft.screens.map((w, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`castscreen${w ? ' is-on' : ''}${picked.includes(i) ? ' is-picked' : ''}${over === i ? ' is-over' : ''}${joinRight(i) ? ' join-r' : ''}${joinDown(i) ? ' join-d' : ''}`}
                    style={w ? { background: tone(w) } : undefined}
                    aria-pressed={picked.includes(i)}
                    onClick={() => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOver(i);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/wall');
                      // Dropped on a selected screen: the whole selection takes the wall.
                      assign(picked.includes(i) ? picked : [i], id || null);
                      setOver(null);
                      setDragging(false);
                      setPicked([]);
                    }}
                  >
                    <span className="castscreen__n">Screen {i + 1}</span>
                    <span className="castscreen__wall">{w ? wallName(w) : 'Drop a wall here'}</span>
                  </button>
                ))}
              </div>
              <p className="meta cast__note">Screens next to each other with the same wall join into one picture. Different walls on one display show side by side.</p>

              <div className="cast__opts">
                <Switch checked={draft.takeover} onChange={(takeover) => setDraft((d) => ({ ...d, takeover }))} label="Alert takeovers on this display" />
                <Switch checked={draft.sound} onChange={(sound) => setDraft((d) => ({ ...d, sound }))} label="Alarm sound in the room" />
                <span className="cast__untilwrap">
                  <span className="cast__untillabel">Stop casting</span>
                  <Choice id="cast-until" label="Stop casting" small className="cast__until" value={draft.until} onChange={(until) => setDraft((d) => ({ ...d, until }))} options={UNTIL} />
                </span>
              </div>
            </>
          ) : (
            <div className="cast__offline">
              <Icon name="wifi" size={28} />
              <strong>{draft.name} is offline</strong>
              <span className="meta">The console cannot reach this display. Pick another, or check its power and network.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
