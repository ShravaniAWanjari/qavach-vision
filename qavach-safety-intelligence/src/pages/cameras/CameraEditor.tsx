import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { CameraView, Choice, Seg, Switch, useConfirm } from '../../components/ui';
import { AREA_DEPARTMENT, AREAS, camId, DEPARTMENTS } from '../../data/seed';
import type { Camera, CameraSource, ZonePurpose } from '../../data/types';
import { backend, rememberPassword, type ProbeResult } from '../../lib/backend';
import { FIRE_PURPOSES, PURPOSE_LABEL, ZONE_COLORS } from '../../scenes/zones';
import { useService } from '../../state/bridge';
import { departmentOf, isAdmin, placementFor, removeCamera, saveCamera, saveRule, saveWall, setCameraOnRule, toast, useCameras, useMe, useRules, useWalls } from '../../state/store';
import { LAYOUT_SLOTS } from '../wall/WallBody';
import { NewRulePanel } from '../rules/NewRulePanel';
import { ZoneEditor } from './ZoneEditor';

type Step = 'connect' | 'zones' | 'walls';

const MAKES = ['Axis Q1786-LE', 'Hanwha XNO-8082R', 'Bosch DINION 5100i', 'Hikvision DS-2CD5A46', 'Other ONVIF camera'];

export function CameraEditor() {
  const { cameraId } = useParams();
  const isNew = !cameraId;
  const cams = useCameras();
  const rules = useRules();
  const walls = useWalls();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const existing = cams.find((c) => c.id === cameraId);
  const canEdit = isAdmin(me);

  const [cam, setCam] = useState<Camera | undefined>(() => existing ?? blank(cams));
  const [step, setStep] = useState<Step>(isNew ? 'connect' : 'zones');
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'fail'>(isNew ? 'idle' : 'ok');
  const [user, setUser] = useState('svc-cctv');
  const [pass, setPass] = useState('');
  const [sel, setSel] = useState<string>();
  const service = useService();
  const [kind, setKind] = useState<'link' | 'upload'>(existing?.source?.kind ?? 'link');
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [wallPlan, setWallPlan] = useState<Record<string, 'off' | 'rolls' | 'pinned'>>({});
  const [rulePlan, setRulePlan] = useState<Record<string, boolean>>({});
  const [newRule, setNewRule] = useState(false);
  // A camera being added starts on the walls and rules that already cover its work area, until someone changes a choice.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (existing && existing.id !== cam?.id) setCam(existing);
    // Only when the route changes to another camera.
  }, [cameraId]);

  useEffect(() => {
    if (!cam) return;
    const plan: Record<string, 'off' | 'rolls' | 'pinned'> = {};
    for (const w of walls) plan[w.id] = w.pinned.includes(cam.id) ? 'pinned' : w.rotation.includes(cam.id) ? 'rolls' : 'off';
    setWallPlan(plan);
    setRulePlan(Object.fromEntries(rules.map((r) => [r.id, r.cameraIds.includes(cam.id)])));
  }, [cam?.id]);

  const suggested = cam && isNew && !touched ? placementFor(cam, cams, rules, walls) : undefined;
  const wallMode = (id: string): 'off' | 'rolls' | 'pinned' => (suggested ? (suggested.walls.includes(id) ? 'rolls' : 'off') : (wallPlan[id] ?? 'off'));
  const ruleOn = (id: string) => (suggested ? suggested.rules.some((r) => r.id === id) : (rulePlan[id] ?? false));
  // The first change turns what was suggested into explicit choices.
  const choose = (patch: { wall?: [string, 'off' | 'rolls' | 'pinned']; rule?: [string, boolean] }) => {
    const wp = Object.fromEntries(walls.map((w) => [w.id, wallMode(w.id)])) as Record<string, 'off' | 'rolls' | 'pinned'>;
    const rp = Object.fromEntries(rules.map((r) => [r.id, ruleOn(r.id)]));
    if (patch.wall) wp[patch.wall[0]] = patch.wall[1];
    if (patch.rule) rp[patch.rule[0]] = patch.rule[1];
    setWallPlan(wp);
    setRulePlan(rp);
    setTouched(true);
  };

  if (!cam) {
    return (
      <div className="page">
        <p>
          Camera {cameraId} not found. <Link to="/cameras">Back to cameras</Link>
        </p>
      </div>
    );
  }

  const set = (p: Partial<Camera>) => setCam({ ...cam, ...p });
  const setArea = (areaId: string) => {
    const area = AREAS.find((a) => a.id === areaId)!;
    const n = cams.filter((c) => c.areaId === areaId).length + 1;
    setCam({ ...cam, areaId, scene: area.scene, id: isNew ? camId(areaId, n) : cam.id, zones: isNew ? [] : cam.zones });
    if (isNew) setTest('idle');
  };

  const isRtsp = /^rtsps?:\/\//i.test(cam.stream.trim());

  /** A source answered: keep its first frame for drawing zones, and what it told us about itself. */
  const applyProbe = (r: ProbeResult, source: CameraSource) => {
    const title = (r.title || (source.fileName ?? '').replace(/\.[^.]+$/, '')).replace(/\s*\(.*$/, '').slice(0, 60);
    setCam((c) => ({
      ...c!,
      name: c!.name || title,
      resolution: `${r.width} × ${r.height}`,
      fps: Math.round(r.fps ?? c!.fps),
      // A real camera is not an Axis or a Hanwha: say what it is instead of keeping the sample default.
      make: r.kind === 'upload' ? 'Uploaded video' : r.kind === 'youtube' ? 'YouTube live stream' : 'Live stream',
      stream: source.kind === 'link' ? (source.url ?? '') : `uploaded: ${source.fileName ?? 'video'}`,
      source: { ...source, frameUrl: r.frameUrl, width: r.width, height: r.height, live: r.live, title: r.title },
    }));
    setErr('');
    setTest('ok');
  };

  const runTest = async () => {
    if (!service.online) {
      // Without the detection service this is the sample flow: a shape check and a drawn scene.
      if (!/^rtsp:\/\/[\w.-]+(:\d+)?\/\S*/.test(cam.stream)) {
        setTest('fail');
        setErr('Use an RTSP address, for example rtsp://10.40.1.25:554/stream1');
        return;
      }
      setTest('testing');
      window.setTimeout(() => setTest('ok'), 1200);
      return;
    }
    const url = cam.stream.trim();
    setTest('testing');
    setErr('');
    try {
      const r = await backend.probeLink(url, isRtsp ? { user, password: pass } : undefined);
      applyProbe(r, { kind: 'link', url, user: isRtsp ? user : undefined });
    } catch (e) {
      setTest('fail');
      setErr((e as Error).message);
    }
  };

  const sendFile = async (file: File | undefined) => {
    if (!file) return;
    setTest('testing');
    setErr('');
    setProgress(0);
    try {
      const r = await backend.upload(file, setProgress);
      applyProbe(r, { kind: 'upload', uploadId: r.uploadId, fileName: file.name });
    } catch (e) {
      setTest('fail');
      setErr((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const usedBy = (zoneId: string) => rules.filter((r) => r.zoneIds.includes(zoneId)).map((r) => r.id);

  const save = () => {
    if (isRtsp) rememberPassword(cam.id, pass);
    saveCamera({ ...cam, addedAt: existing?.addedAt ?? Date.now(), addedBy: existing?.addedBy ?? me.id, status: existing?.status ?? 'online' });
    for (const w of walls) {
      const want = wallMode(w.id);
      let pinned = w.pinned.map((p) => (p === cam.id ? null : p));
      let rotation = w.rotation.filter((id) => id !== cam.id);
      if (want === 'rolls') rotation = [...rotation, cam.id];
      if (want === 'pinned') {
        const slots = LAYOUT_SLOTS[w.pinnedLayout];
        const free = pinned.slice(0, slots).findIndex((p) => !p);
        const i = free >= 0 ? free : Math.min(pinned.length, slots - 1);
        pinned = [...pinned];
        while (pinned.length <= i) pinned.push(null);
        pinned[i] = cam.id;
        rotation = [...rotation, cam.id];
      }
      if (want !== (w.pinned.includes(cam.id) ? 'pinned' : w.rotation.includes(cam.id) ? 'rolls' : 'off')) saveWall({ ...w, pinned, rotation });
    }
    // Rules: the camera joins the ones ticked and leaves the ones that are not, with the zones that go with it.
    const place = placementFor(cam, cams, rules, walls);
    for (const r of rules) {
      const want = ruleOn(r.id);
      if (want === r.cameraIds.includes(cam.id) && !(want && isNew)) continue;
      saveRule(setCameraOnRule(r, cam, want, place.rules.find((x) => x.id === r.id)?.zoneIds ?? []));
    }
    toast(isNew ? `${cam.id} ${cam.name} added with ${cam.zones.length} zones` : `${cam.id} saved`);
    nav(isNew ? `/cameras/${cam.id}` : '/cameras');
  };

  const steps: { id: Step; label: string }[] = [
    { id: 'connect', label: '1 · Connect' },
    { id: 'zones', label: `2 · Draw zones (${cam.zones.length})` },
    { id: 'walls', label: '3 · Rules and walls' },
  ];
  const selZone = cam.zones.find((z) => z.id === sel);
  const canNext = step !== 'connect' || test === 'ok';

  return (
    <div className="page camsetup">
      <div className="page__head">
        <div className="page__title">
          <span className="page__sub">{isNew ? 'Add a camera' : `${cam.id} · ${cam.name}`}</span>
        </div>
        <div className="page__actions">
          {!isNew && canEdit && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() =>
                confirm.ask({ title: `Remove ${cam.id}?`, message: 'Its zones go too, and it comes off every rule and wall.', action: 'Remove camera' }, () => {
                  removeCamera(cam.id);
                  toast(`${cam.id} removed`);
                  nav('/cameras');
                })
              }
            >
              <Icon name="trash" size={16} />
              Remove camera
            </button>
          )}
        </div>
      </div>

      {confirm.dialog}
      <ReadOnlyNote>Only the safety admin adds cameras and draws zones.</ReadOnlyNote>

      <div className="tabs" role="tablist">
        {steps.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={step === s.id} onClick={() => (s.id === 'connect' || test === 'ok' ? setStep(s.id) : undefined)} disabled={s.id !== 'connect' && test !== 'ok'}>
            {s.label}
          </button>
        ))}
      </div>

      <fieldset className="plain" disabled={!canEdit}>
        {step === 'connect' && (
          <div className="camedit">
            <div className="card card--pad stack">
              <div className="grid-2" style={{ gap: 12 }}>
                <Choice id="c-area" label="Work Area" value={cam.areaId} onChange={setArea} disabled={!isNew} options={AREAS.map((a) => ({ value: a.id, label: a.name }))} />
                <Choice
                  id="c-dept"
                  label="Department"
                  value={departmentOf(cam)}
                  onChange={(d) => set({ department: d === AREA_DEPARTMENT[cam.areaId] ? undefined : d })}
                  options={[...new Set([...DEPARTMENTS, ...cams.map(departmentOf)])].map((d) => ({ value: d, label: d }))}
                />
              </div>
              <div className="grid-2" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="c-id">Camera ID</label>
                  <input id="c-id" className="input mono" value={cam.id} readOnly />
                </div>
                <div className="field">
                  <label htmlFor="c-name">Camera Location</label>
                  <input id="c-name" className="input" value={cam.name} onChange={(e) => set({ name: e.target.value })} placeholder="For example: Berth 2 · deck port side" />
                </div>
              </div>
              {service.online ? (
                <div className="field">
                  <span className="field__label">Where the picture comes from</span>
                  <Seg
                    label="Source"
                    value={kind}
                    onChange={(v) => {
                      setKind(v);
                      setErr('');
                      if (isNew) setTest('idle');
                    }}
                    options={[
                      { value: 'link', label: 'Live link or address' },
                      { value: 'upload', label: 'Upload a video' },
                    ]}
                  />
                </div>
              ) : (
                <span className="chip chip--warn">Detection service not running: only the sample flow works. Start it with backend/run.sh to use a real camera.</span>
              )}
              {kind === 'link' || !service.online ? (
                <>
                  <div className="field">
                    <label htmlFor="c-url">{service.online ? 'YouTube live link or stream address' : 'Stream address (RTSP)'}</label>
                    <input
                      id="c-url"
                      className="input mono"
                      value={cam.stream}
                      onChange={(e) => {
                        set({ stream: e.target.value });
                        if (isNew) setTest('idle');
                      }}
                      placeholder={service.online ? 'https://www.youtube.com/live/…  or  rtsp://10.40.1.25:554/stream1' : 'rtsp://10.40.1.25:554/stream1'}
                    />
                    <span className="field__hint">A YouTube live link, or a camera's stream on the network (RTSP, or an http / HLS stream). The detection service pulls it; nothing is exposed outside.</span>
                  </div>
                  {(isRtsp || !service.online) && (
                    <div className="grid-2" style={{ gap: 12 }}>
                      <div className="field">
                        <label htmlFor="c-user">User name</label>
                        <input id="c-user" className="input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
                      </div>
                      <div className="field">
                        <label htmlFor="c-pass">Password</label>
                        <input id="c-pass" className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" placeholder={isNew ? '' : 'Saved · leave blank to keep'} />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="field">
                  <span className="field__label">Video file</span>
                  <input ref={picker} type="file" accept="video/*,.mkv" hidden onChange={(e) => { void sendFile(e.target.files?.[0]); e.target.value = ''; }} />
                  <div className="row">
                    <button type="button" className="btn btn--secondary" onClick={() => picker.current?.click()} disabled={test === 'testing'}>
                      <Icon name="camera" size={16} />
                      {cam.source?.kind === 'upload' ? 'Choose another video' : 'Choose a video'}
                    </button>
                    {progress !== null && <span className="meta">Uploading {Math.round(progress * 100)}%</span>}
                    {progress === null && cam.source?.kind === 'upload' && <span className="meta">{cam.source.fileName}</span>}
                  </div>
                  <span className="field__hint">mp4, mov, avi, mkv or webm. It plays in real time and starts over when it ends, like a camera that is always on. Use it when the live feed has nothing happening.</span>
                </div>
              )}
              {!service.online && !cam.source && (
                <Choice id="c-make" label="Make and Model" value={cam.make} onChange={(make) => set({ make })} options={MAKES.map((m) => ({ value: m, label: m }))} />
              )}
              <div className="row">
                {(kind === 'link' || !service.online) && (
                  <button type="button" className="btn btn--secondary" onClick={() => void runTest()} disabled={test === 'testing' || !cam.stream.trim()}>
                    <Icon name="wifi" size={16} />
                    {test === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                )}
                {test === 'testing' && kind === 'upload' && <span className="meta">Reading the video…</span>}
                {test === 'ok' && (
                  <span className="chip chip--good">
                    <Icon name="check" size={14} />
                    Connected · {cam.resolution} · {cam.fps}fps · {cam.source ? (cam.source.live ? 'live' : 'video, plays in a loop') : 'H.265'}
                  </span>
                )}
                {test === 'fail' && <span className="chip chip--danger">{err || 'Could not connect'}</span>}
              </div>
            </div>
            <div className="stack">
              {test === 'ok' ? (
                <CameraView cam={cam} still={!!cam.source} frozen />
              ) : (
                <div className="camedit__placeholder">
                  <Icon name="camera" size={30} />
                  <span>{test === 'testing' ? 'Connecting to the camera…' : 'Test the connection to see the picture'}</span>
                </div>
              )}
              <p className="meta">{cam.source ? 'This is a real frame from the source. ' : ''}Next you draw the zones on this picture. Detection only runs inside the zones you draw.</p>
            </div>
          </div>
        )}

        {step === 'zones' && (
          <div className="camedit camedit--zones">
            <ZoneEditor cam={cam} zones={cam.zones} onChange={(zones) => set({ zones })} selectedId={sel} onSelect={setSel} readOnly={!canEdit} />
            <div className="card">
              <div className="card__head">
                <h2>Zones on this camera</h2>
              </div>
              <div className="card__body stack">
                {cam.zones.length === 0 && <p className="meta">No zones yet. Pick “Draw an area” or “Draw a line”, then click on the picture.</p>}
                {cam.zones.map((z) => (
                  <div key={z.id} className={`zonerow${z.id === sel ? ' is-sel' : ''}`} onClick={() => setSel(z.id)}>
                    <span className="zonerow__swatch" style={{ background: ZONE_COLORS[z.purpose] }} />
                    <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                      <input className="input input--sm" aria-label="Zone name" value={z.name} onChange={(e) => set({ zones: cam.zones.map((x) => (x.id === z.id ? { ...x, name: e.target.value } : x)) })} />
                      <Choice
                        small
                        label="What the zone is"
                        value={z.purpose}
                        onChange={(purpose) => set({ zones: cam.zones.map((x) => (x.id === z.id ? { ...x, purpose } : x)) })}
                        options={
                          z.kind === 'line'
                            ? (['line', 'deck-edge'] as ZonePurpose[]).map((p) => ({ value: p, label: PURPOSE_LABEL[p] }))
                            : [
                                ...(['restricted', 'exclusion', 'walkway', 'work-area', 'vehicle-lane'] as ZonePurpose[]).map((p) => ({ value: p, label: PURPOSE_LABEL[p], group: 'People and vehicles' })),
                                ...FIRE_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p], group: 'Fire and smoke' })),
                              ]
                        }
                      />
                      <span className="meta">
                        {z.kind === 'line' ? 'Line' : `Area · ${z.points.length} corners`}
                        {usedBy(z.id).length > 0 && ` · used by ${usedBy(z.id).join(', ')}`}
                      </span>
                    </div>
                  </div>
                ))}
                {selZone && <p className="meta">Selected: {selZone.name}. Drag its corners on the picture to adjust.</p>}
              </div>
            </div>
          </div>
        )}

        {step === 'walls' && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card__head">
              <h2>Apply rules</h2>
              <span className="meta">Rules already watching other cameras of this work area are ticked.</span>
              <span className="spacer" />
              {canEdit && (
                <button type="button" className="qact__btn" onClick={() => setNewRule(true)}>
                  <Icon name="add-circle" size={20} />
                  New rule
                </button>
              )}
            </div>
            <table className="table camsetup__table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Level</th>
                  <th>Watches this camera</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="meta">
                        <span className="mono">{r.id}</span> · {r.cameraIds.filter((id) => id !== cam.id).length} other cameras
                      </div>
                    </td>
                    <td>{r.priority}</td>
                    <td>
                      <Switch checked={ruleOn(r.id)} onChange={(v) => choose({ rule: [r.id, v] })} label={ruleOn(r.id) ? 'Yes' : 'No'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {newRule && cam && (
          <NewRulePanel
            forCamera={cam.id}
            onCreated={(r) => choose({ rule: [r.id, true] })}
            onClose={() => setNewRule(false)}
          />
        )}
        {step === 'walls' && (
          <div className="card">
            <div className="card__head">
              <h2>Where this camera shows</h2>
              <span className="meta">Pinned cameras stay on screen; the others take turns in the rolling section.</span>
            </div>
            <table className="table camsetup__table">
              <thead>
                <tr>
                  <th>Wall</th>
                  <th>Team</th>
                  <th>On this wall</th>
                </tr>
              </thead>
              <tbody>
                {walls.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <strong>{w.name}</strong>
                    </td>
                    <td className="muted">{w.teamId === 't-quay' ? 'Quay and marine' : w.teamId === 't-yard' ? 'Yard and gate' : 'HSE control room'}</td>
                    <td>
                      <div className="seg seg--sm" role="group" aria-label={`On ${w.name}`}>
                        {(['off', 'rolls', 'pinned'] as const).map((v) => (
                          <button key={v} type="button" aria-pressed={wallMode(w.id) === v} onClick={() => choose({ wall: [w.id, v] })} disabled={v === 'pinned' && w.pinnedShare === 0}>
                            {v === 'off' ? 'Not shown' : v === 'rolls' ? 'Rolls' : 'Pinned'}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>

      <div className="camedit__foot">
        <Link to="/cameras" className="btn btn--secondary">
          Cancel
        </Link>
        <span className="spacer" />
        {step !== 'connect' && (
          <button type="button" className="btn btn--secondary" onClick={() => setStep(step === 'walls' ? 'zones' : 'connect')}>
            Back
          </button>
        )}
        {step !== 'walls' ? (
          <button type="button" className="btn btn--secondary" onClick={() => setStep(step === 'connect' ? 'zones' : 'walls')} disabled={!canNext}>
            Next
            <Icon name="arrow-right" size={16} />
          </button>
        ) : null}
        {canEdit && (
          <button type="button" className="btn" onClick={save} disabled={test !== 'ok' || !cam.name.trim()}>
            {isNew ? 'Add camera' : 'Save camera'}
          </button>
        )}
      </div>
    </div>
  );
}

function blank(cams: Camera[]): Camera {
  const n = cams.filter((c) => c.areaId === 'deck').length + 1;
  return {
    id: camId('deck', n),
    name: '',
    areaId: 'deck',
    scene: 'deck',
    variant: (n * 3) % 8,
    status: 'online',
    stream: '',
    make: MAKES[0],
    resolution: '2560 × 1440',
    fps: 20,
    zones: [],
    addedAt: Date.now(),
    addedBy: '',
  };
}
