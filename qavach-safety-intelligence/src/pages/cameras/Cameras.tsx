import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon, type IconName } from '../../components/Icon';
import { CameraView, Choice, Empty, MultiSelect } from '../../components/ui';
import { AREAS, DEPARTMENTS } from '../../data/seed';
import type { Camera } from '../../data/types';
import { download, writeXlsx } from '../../lib/sheet';
import { setupFile } from '../../lib/setup';
import { alertStore, AREAS_BY_ID, cameraStore, departmentOf, isAdmin, policyStore, ruleStore, useCameras, useMe, useRules, wallStore } from '../../state/store';
import { ASSET_COLUMNS, assetRow, CameraImport } from './CameraImport';
import './cameras.css';

// The camera directory: every camera asset with what it is, where it is, which work area it covers and which
// department owns it. Browse it as thumbnails, a list or Finder-style columns with a preview.

type View = 'grid' | 'list' | 'columns';
const VIEWS: { value: View; label: string; icon: IconName }[] = [
  { value: 'grid', label: 'Thumbnails', icon: 'grid' },
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'columns', label: 'Columns', icon: 'columns' },
];
const VIEW_KEY = 'qsi.v1.cameraView';
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'list' || v === 'columns' ? v : 'grid';
  } catch {
    return 'grid';
  }
};

type Show = 'all' | 'nozones' | 'issues';
const STATUS_TEXT: Record<Camera['status'], string> = { online: 'Online', degraded: 'Degraded', offline: 'Offline' };

/** Departments in their usual order, then any others the register uses. */
const departmentsIn = (cams: Camera[]) => {
  const used = new Set(cams.map(departmentOf));
  return [...DEPARTMENTS.filter((d) => used.has(d)), ...[...used].filter((d) => !DEPARTMENTS.includes(d)).sort()];
};

export function Cameras() {
  const cams = useCameras();
  const rules = useRules();
  const me = useMe();
  const admin = isAdmin(me);
  const [depts, setDepts] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [idQ, setIdQ] = useState('');
  const [locQ, setLocQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [view, setViewState] = useState<View>(savedView);
  const [importing, setImporting] = useState(false);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the view just isn't remembered */
    }
  };

  const allDepts = departmentsIn(cams);
  const areaChoices = AREAS.filter((a) => !depts.length || cams.some((c) => c.areaId === a.id && depts.includes(departmentOf(c))));
  const id = idQ.trim().toLowerCase();
  const loc = locQ.trim().toLowerCase();
  const list = cams.filter(
    (c) =>
      (!depts.length || depts.includes(departmentOf(c))) &&
      (!areas.length || areas.includes(c.areaId)) &&
      (!id || c.id.toLowerCase().includes(id)) &&
      (!loc || c.name.toLowerCase().includes(loc)) &&
      (show === 'all' || (show === 'nozones' ? c.zones.length === 0 : c.status !== 'online')),
  );
  const ruleCount = (camId: string) => rules.filter((r) => r.cameraIds.includes(camId)).length;
  const online = list.filter((c) => c.status === 'online').length;
  const zoned = cams.filter((c) => c.zones.length).length;

  return (
    <div className="page">
      <div className="qsearch qsearch--first camsearch">
        <div className="camsearch__main">
        <div className="camsearch__fields">
          <MultiSelect
            id="cam-dept"
            label="Department"
            clearable
            placeholder="All departments"
            options={allDepts.map((d) => ({ value: d, label: d }))}
            value={depts}
            onChange={(v) => {
              setDepts(v);
              setAreas((a) => a.filter((x) => !v.length || cams.some((c) => c.areaId === x && v.includes(departmentOf(c)))));
            }}
          />
          <MultiSelect id="cam-area" label="Work Area" clearable placeholder="All work areas" options={areaChoices.map((a) => ({ value: a.id, label: a.name }))} value={areas} onChange={setAreas} />
          <div className="field">
            <label htmlFor="cam-id">Camera ID</label>
            <input id="cam-id" className="input" placeholder="For example: QUA-03" value={idQ} onChange={(e) => setIdQ(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cam-loc">Camera Location</label>
            <input id="cam-loc" className="input" placeholder="For example: Berth 2" value={locQ} onChange={(e) => setLocQ(e.target.value)} />
          </div>
          <Choice
            id="cam-show"
            label="Status"
            value={show}
            clearTo="all"
            onChange={setShow}
            options={[
              { value: 'all' as Show, label: 'All cameras' },
              { value: 'nozones' as Show, label: `Need zones (${cams.length - zoned})` },
              { value: 'issues' as Show, label: `Offline or degraded (${cams.filter((c) => c.status !== 'online').length})` },
            ]}
          />
        </div>
          <button
            type="button"
            className="qsearch__clear camsearch__clear"
            onClick={() => {
              setDepts([]);
              setAreas([]);
              setIdQ('');
              setLocQ('');
              setShow('all');
            }}
          >
            Clear Search
          </button>
        </div>
        <div className="camsearch__actions">
          <div className="viewswitch" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} title={v.label} aria-label={v.label} onClick={() => setView(v.value)}>
                <Icon name={v.icon} size={20} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="listbar listbar--under">
        <span className="listing-tag">
          Listing 1 - {list.length} Of {cams.length} · {online} online · {list.filter((c) => c.zones.length).length} with zones drawn
        </span>
        <button type="button" className="qact__btn" onClick={() => download(writeXlsx([[...ASSET_COLUMNS, 'Status', 'Zones', 'Rules'], ...list.map((c) => [...assetRow(c), STATUS_TEXT[c.status], c.zones.length, ruleCount(c.id)])], 'Cameras'), 'camera-asset-list.xlsx')}>
          <Icon name="download" size={22} />
          Export
        </button>
        {admin && (
          <button
            type="button"
            className="qact__btn"
            title="Save The Cameras, Rules, Walls And Alerts As They Are Now, To Use As The Sample Data For Everyone"
            onClick={() => download(setupFile({ cameras: cameraStore.get(), rules: ruleStore.get(), walls: wallStore.get(), alerts: alertStore.get(), policies: policyStore.get() }), 'qavach-setup.json')}
          >
            <Icon name="download" size={22} />
            Save set-up
          </button>
        )}
        {admin && (
          <button type="button" className="qact__btn" onClick={() => setImporting(true)}>
            <Icon name="upload" size={22} />
            Import
          </button>
        )}
        {admin && (
          <Link to="/configuration/cameras" className="qact__btn">
            <Icon name="add-circle" size={24} />
            Add camera
          </Link>
        )}
      </div>

      {list.length === 0 ? (
        <Empty icon="camera" title="No Cameras Match">
          Change the search, or clear it to see the whole register.
        </Empty>
      ) : view === 'grid' ? (
        <ThumbView list={list} ruleCount={ruleCount} />
      ) : view === 'list' ? (
        <ListView list={list} ruleCount={ruleCount} />
      ) : (
        <ColumnView list={list} ruleCount={ruleCount} />
      )}

      {importing && <CameraImport onClose={() => setImporting(false)} />}
    </div>
  );
}

type ViewProps = { list: Camera[]; ruleCount: (id: string) => number };

function Chips({ c, ruleCount }: { c: Camera; ruleCount: (id: string) => number }) {
  const n = ruleCount(c.id);
  return (
    <div className="row-wrap">
      {c.zones.length ? <span className="chip">{c.zones.length} {c.zones.length === 1 ? 'zone' : 'zones'}</span> : <span className="chip chip--warn">No zones yet</span>}
      {n > 0 && <span className="chip">{n} {n === 1 ? 'rule' : 'rules'}</span>}
      {c.status !== 'online' && <span className={`chip ${c.status === 'offline' ? 'chip--danger' : 'chip--warn'}`}>{c.status}</span>}
    </div>
  );
}

/** Thumbnails, grouped by work area like folders. */
function ThumbView({ list, ruleCount }: ViewProps) {
  return (
    <>
      {AREAS.map((a) => {
        const items = list.filter((c) => c.areaId === a.id);
        if (!items.length) return null;
        return (
          <section key={a.id} className="camarea">
            <h2>
              {a.name}
              <span className="meta">
                {departmentsIn(items).join(', ')} · {items.length} {items.length === 1 ? 'camera' : 'cameras'}
                {a.highOps ? ' · high-operational area' : ''}
              </span>
            </h2>
            <div className="camgrid">
              {items.map((c) => (
                <Link key={c.id} to={`/configuration/cameras/${c.id}`} className="camcard">
                  <CameraView cam={c} still zones={c.zones} caption={false} />
                  <div className="camcard__body">
                    <div className="row">
                      <span className={`dot dot--${c.status}`} title={c.status} />
                      <span className="mono">{c.id}</span>
                      <span className="ellipsis">{c.name}</span>
                    </div>
                    <Chips c={c} ruleCount={ruleCount} />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

type SortKey = 'id' | 'name' | 'area' | 'dept' | 'status' | 'zones' | 'rules';

/** One row per camera, every column sortable. */
function ListView({ list, ruleCount }: ViewProps) {
  const nav = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: 'id', up: true });
  const value = (c: Camera): string | number =>
    sort.key === 'name' ? c.name : sort.key === 'area' ? (AREAS_BY_ID[c.areaId]?.name ?? '') : sort.key === 'dept' ? departmentOf(c) : sort.key === 'status' ? STATUS_TEXT[c.status] : sort.key === 'zones' ? c.zones.length : sort.key === 'rules' ? ruleCount(c.id) : c.id;
  const rows = [...list].sort((x, y) => {
    const a = value(x);
    const b = value(y);
    const d = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
    return (sort.up ? d : -d) || x.id.localeCompare(y.id, undefined, { numeric: true });
  });
  const head = (k: SortKey, text: string) => (
    <th aria-sort={sort.key === k ? (sort.up ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sorthead" onClick={() => setSort((s) => ({ key: k, up: s.key === k ? !s.up : true }))}>
        {text}
        <Icon name="chevron-down" size={14} stroke={2.2} className={`sorthead__arrow${sort.key === k ? ' is-on' : ''}${sort.key === k && sort.up ? ' is-up' : ''}`} />
      </button>
    </th>
  );
  return (
    <div className="card camlist">
      <table className="table">
        <thead>
          <tr>
            {head('id', 'Camera ID')}
            {head('name', 'Camera Location')}
            {head('area', 'Work Area')}
            {head('dept', 'Department')}
            {head('status', 'Status')}
            {head('zones', 'Zones')}
            {head('rules', 'Rules')}
            <th>Stream</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="is-clickable" onClick={() => nav(`/configuration/cameras/${c.id}`)}>
              <td className="mono">{c.id}</td>
              <td>
                <strong>{c.name}</strong>
              </td>
              <td>{AREAS_BY_ID[c.areaId]?.name}</td>
              <td>{departmentOf(c)}</td>
              <td>
                <span className="row" style={{ gap: 6 }}>
                  <span className={`dot dot--${c.status}`} />
                  {STATUS_TEXT[c.status]}
                </span>
              </td>
              <td>{c.zones.length || <span className="chip chip--warn">None</span>}</td>
              <td>{ruleCount(c.id)}</td>
              <td className="mono ellipsis" style={{ maxWidth: 260 }}>
                {c.source ? (c.source.title ?? c.source.fileName ?? 'Connected source') : c.stream}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Finder-style columns: department, then work area, then camera, with a preview of the chosen camera. */
function ColumnView({ list, ruleCount }: ViewProps) {
  const nav = useNavigate();
  const depts = departmentsIn(list);
  const [deptSel, setDept] = useState<string>();
  const dept = deptSel && depts.includes(deptSel) ? deptSel : depts[0];
  const inDept = list.filter((c) => departmentOf(c) === dept);
  const areaIds = AREAS.filter((a) => inDept.some((c) => c.areaId === a.id)).map((a) => a.id);
  const [areaSel, setArea] = useState<string>();
  const area = areaSel && areaIds.includes(areaSel) ? areaSel : areaIds[0];
  const inArea = inDept.filter((c) => c.areaId === area);
  const [camSel, setCam] = useState<string>();
  const cam = inArea.find((c) => c.id === camSel) ?? inArea[0];
  const rulesOn = cam ? ruleCount(cam.id) : 0;

  return (
    <div className="colview card">
      <div className="colview__col">
        <div className="colview__head">Departments</div>
        <div className="colview__items">
          {depts.map((d) => (
            <button key={d} type="button" className={`colview__item${d === dept ? ' is-sel' : ''}`} onClick={() => setDept(d)}>
              <span className="ellipsis">{d}</span>
              <span className="colview__n">{list.filter((c) => departmentOf(c) === d).length}</span>
              <Icon name="chevron-right" size={16} stroke={2.2} />
            </button>
          ))}
        </div>
      </div>
      <div className="colview__col">
        <div className="colview__head">Work Areas</div>
        <div className="colview__items">
          {areaIds.map((a) => (
            <button key={a} type="button" className={`colview__item${a === area ? ' is-sel' : ''}`} onClick={() => setArea(a)}>
              <span className="ellipsis">{AREAS_BY_ID[a]?.name}</span>
              <span className="colview__n">{inDept.filter((c) => c.areaId === a).length}</span>
              <Icon name="chevron-right" size={16} stroke={2.2} />
            </button>
          ))}
        </div>
      </div>
      <div className="colview__col">
        <div className="colview__head">Cameras</div>
        <div className="colview__items">
          {inArea.map((c) => (
            <button key={c.id} type="button" className={`colview__item${c.id === cam?.id ? ' is-sel' : ''}`} onClick={() => setCam(c.id)} onDoubleClick={() => nav(`/cameras/${c.id}`)} title="Double-click To Open The Camera Set-up">
              <span className={`dot dot--${c.status}`} />
              <span className="mono">{c.id}</span>
              <span className="ellipsis">{c.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="colview__preview">
        {cam && (
          <>
            <CameraView cam={cam} still zones={cam.zones} caption={false} />
            <div className="colview__title">
              <span className="mono">{cam.id}</span>
              <strong>{cam.name}</strong>
            </div>
            <dl className="kv colview__kv">
              <dt>Work Area</dt>
              <dd>{AREAS_BY_ID[cam.areaId]?.name}</dd>
              <dt>Department</dt>
              <dd>{departmentOf(cam)}</dd>
              <dt>Status</dt>
              <dd className="row" style={{ gap: 6 }}>
                <span className={`dot dot--${cam.status}`} />
                {STATUS_TEXT[cam.status]}
              </dd>
              <dt>Stream</dt>
              <dd className="mono ellipsis">{cam.source ? (cam.source.title ?? cam.source.fileName ?? 'Connected source') : cam.stream || '–'}</dd>
              <dt>Make and Model</dt>
              <dd>{cam.make}</dd>
              <dt>Resolution</dt>
              <dd>
                {cam.resolution} · {cam.fps}fps
              </dd>
              <dt>Zones</dt>
              <dd>{cam.zones.length ? cam.zones.map((z) => z.name).join(', ') : 'None yet'}</dd>
              <dt>Rules</dt>
              <dd>{rulesOn ? `${rulesOn} ${rulesOn === 1 ? 'rule watches it' : 'rules watch it'}` : 'None'}</dd>
            </dl>
            <button type="button" className="btn" onClick={() => nav(`/configuration/cameras/${cam.id}`)}>
              Open camera set-up
            </button>
          </>
        )}
      </div>
    </div>
  );
}
