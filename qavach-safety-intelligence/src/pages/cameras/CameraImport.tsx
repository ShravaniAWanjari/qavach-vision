import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { AREA_DEPARTMENT, AREAS } from '../../data/seed';
import type { Camera } from '../../data/types';
import { download, readSheet, writeXlsx, type Cell } from '../../lib/sheet';
import { departmentOf, saveCamera, toast, useCameras, useMe } from '../../state/store';

// The camera asset list as a spreadsheet: one row per camera. The same columns are used by the template, the
// import and the export, so a list exported from here can be edited in Excel and imported back.
export const ASSET_COLUMNS = ['Camera ID', 'Camera Location', 'Work Area', 'Department', 'Stream Address', 'Make and Model', 'Resolution', 'FPS'] as const;

export function assetRow(c: Camera): Cell[] {
  return [c.id, c.name, AREAS.find((a) => a.id === c.areaId)?.name ?? c.areaId, departmentOf(c), c.source ? '' : c.stream, c.make, c.resolution, c.fps];
}

export function downloadTemplate() {
  download(
    writeXlsx(
      [
        [...ASSET_COLUMNS],
        ['QUA-15', 'Berth 1 · bollard 12', AREAS[0].name, AREA_DEPARTMENT.quay, 'rtsp://10.40.1.60:554/stream1', 'Axis Q1786-LE', '2560 × 1440', 20],
        ['GTE-13', 'Out-gate lane 5', AREAS[4].name, AREA_DEPARTMENT.gate, 'rtsp://10.40.1.61:554/stream1', 'Hanwha XNO-8082R', '3840 × 2160', 15],
      ],
      'Cameras',
    ),
    'camera-asset-list-template.xlsx',
  );
}

type Row = { line: number; cam?: Camera; isNew: boolean; error?: string; values: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES: Record<string, (typeof ASSET_COLUMNS)[number]> = {
  cameraid: 'Camera ID', id: 'Camera ID',
  cameralocation: 'Camera Location', location: 'Camera Location', name: 'Camera Location',
  workarea: 'Work Area', area: 'Work Area',
  department: 'Department', dept: 'Department',
  streamaddress: 'Stream Address', stream: 'Stream Address', rtsp: 'Stream Address', url: 'Stream Address',
  makeandmodel: 'Make and Model', make: 'Make and Model', model: 'Make and Model',
  resolution: 'Resolution',
  fps: 'FPS', framerate: 'FPS',
};

/** Checks each row against the cameras already registered: a known ID updates that camera, a new one adds it. */
function readRows(sheet: string[][], cams: Camera[], userId: string): Row[] {
  const head = (sheet[0] ?? []).map((h) => HEADER_ALIASES[norm(h)]);
  if (!head.includes('Camera ID')) throw new Error('The first row must hold the column names, including “Camera ID”. Download the template to see them.');
  const seen = new Set<string>();
  return sheet
    .slice(1)
    .map((cells, i) => ({ cells, line: i + 2 }))
    .filter(({ cells }) => cells.some((c) => c))
    .map(({ cells, line }) => {
      const get = (col: (typeof ASSET_COLUMNS)[number]) => cells[head.indexOf(col)] ?? '';
      const values = ASSET_COLUMNS.map((c) => get(c));
      const id = get('Camera ID').toUpperCase();
      const existing = cams.find((c) => c.id === id);
      const areaText = norm(get('Work Area'));
      const area = AREAS.find((a) => norm(a.name) === areaText || a.id === areaText) ?? (existing ? AREAS.find((a) => a.id === existing.areaId) : undefined);
      const fail = (error: string): Row => ({ line, isNew: !existing, error, values });
      if (!id) return fail('Camera ID is missing');
      if (seen.has(id)) return fail(`${id} appears twice in the file`);
      seen.add(id);
      if (!area) return fail(get('Work Area') ? `Unknown work area “${get('Work Area')}”` : 'Work area is missing');
      if (!existing && !get('Camera Location')) return fail('Camera location is missing');
      const fps = get('FPS') ? Number(get('FPS')) : undefined;
      if (fps !== undefined && !(fps > 0 && fps <= 60)) return fail('FPS must be a number from 1 to 60');
      const department = get('Department') || undefined;
      const base: Camera = existing ?? {
        id,
        name: '',
        areaId: area.id,
        scene: area.scene,
        variant: cams.filter((c) => c.areaId === area.id).length % 8,
        status: 'online',
        stream: '',
        make: 'Other ONVIF camera',
        resolution: '2560 × 1440',
        fps: 20,
        zones: [],
        addedAt: Date.now(),
        addedBy: userId,
      };
      const cam: Camera = {
        ...base,
        name: get('Camera Location') || base.name,
        areaId: area.id,
        scene: area.scene,
        department: department && department !== AREA_DEPARTMENT[area.id] ? department : existing?.department && !department ? existing.department : undefined,
        stream: base.source ? base.stream : get('Stream Address') || base.stream,
        make: get('Make and Model') || base.make,
        resolution: get('Resolution') || base.resolution,
        fps: fps ?? base.fps,
      };
      return { line, cam, isNew: !existing, values };
    });
}

/** Upload an Excel asset list, see what each row will do, then add or update the cameras in one go. */
export function CameraImport({ onClose }: { onClose: () => void }) {
  const cams = useCameras();
  const me = useMe();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const ok = rows?.filter((r) => r.cam) ?? [];
  const added = ok.filter((r) => r.isNew).length;

  const choose = async (f?: File) => {
    if (!f) return;
    setFile(f.name);
    setError('');
    setRows(null);
    try {
      setRows(readRows(await readSheet(f), cams, me.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title="Import Camera Assets"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!ok.length}
            onClick={() => {
              ok.forEach((r) => saveCamera(r.cam!));
              toast(`${added} ${added === 1 ? 'camera' : 'cameras'} added, ${ok.length - added} updated`);
              onClose();
            }}
          >
            Import {ok.length || ''} {ok.length === 1 ? 'camera' : 'cameras'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <div className="cimport__steps">
          <div className="cimport__step">
            <span className="cimport__num">1</span>
            <div className="stack" style={{ gap: 4 }}>
              <strong>Fill in the asset list</strong>
              <span className="meta">One row per camera: {ASSET_COLUMNS.join(', ')}. A Camera ID already in the register updates that camera.</span>
              <button type="button" className="qact__btn cimport__link" onClick={downloadTemplate}>
                <Icon name="download" size={20} />
                Download template
              </button>
            </div>
          </div>
          <div className="cimport__step">
            <span className="cimport__num">2</span>
            <div className="stack" style={{ gap: 4 }}>
              <strong>Upload it</strong>
              <span className="meta">Excel (.xlsx) or CSV. Stream passwords are never imported; enter them on each camera.</span>
              <button type="button" className="qact__btn cimport__link" onClick={() => input.current?.click()}>
                <Icon name="upload" size={20} />
                {file ? 'Choose another file' : 'Choose file'}
              </button>
              <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => choose(e.target.files?.[0])} />
            </div>
          </div>
        </div>

        {error && <div className="cimport__error">{error}</div>}

        {rows && (
          <>
            <span className="listing-tag" style={{ margin: 0 }}>
              {file}: {rows.length} rows · {added} new · {ok.length - added} updates · {rows.length - ok.length} with errors, skipped
            </span>
            <div className="cimport__table">
              <table className="table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Result</th>
                    {ASSET_COLUMNS.slice(0, 5).map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.line}>
                      <td className="mono">{r.line}</td>
                      <td>{r.error ? <span className="chip chip--danger">{r.error}</span> : <span className={`chip ${r.isNew ? 'chip--good' : 'chip--ai'}`}>{r.isNew ? 'New' : 'Update'}</span>}</td>
                      {r.values.slice(0, 5).map((v, i) => (
                        <td key={i} className={i === 0 ? 'mono' : undefined}>
                          {i === 3 && !v && r.cam ? <span className="faint">{departmentOf(r.cam)}</span> : v || <span className="faint">–</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
