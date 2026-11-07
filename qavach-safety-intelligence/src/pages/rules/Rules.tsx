import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { CascadeSelect, type CascadeField, Choice, PRIORITY_NAME, PriorityBadge, SearchActions, Switch } from '../../components/ui';
import type { Classification, Condition, Priority, QavachRecordType, Rule, Schedule, Subject } from '../../data/types';
import { CONDITION_LABEL, describeRule, SCHEDULE_LABEL, SUBJECT_LABEL } from '../../lib/qai';
import { AREAS_BY_ID, isAdmin, saveRule, toast, useAlerts, useCameras, useMe, useRules } from '../../state/store';
import './rules.css';

const LEVELS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const RECORDS: (QavachRecordType | 'none')[] = ['Incident', 'Near miss', 'Observation', 'none'];

type SortField = 'id' | 'name' | 'priority' | 'alerts' | 'status';
type SortDir = 'a' | 'b';
/** What a rule list can be ordered by, each with its two directions: the first is the one most people want. */
const SORT_FIELDS: CascadeField<SortField, SortDir>[] = [
  { key: 'id', label: 'Rule ID', options: [{ value: 'a', label: 'Lowest first' }, { value: 'b', label: 'Highest first' }] },
  { key: 'name', label: 'Name', options: [{ value: 'a', label: 'A to Z' }, { value: 'b', label: 'Z to A' }] },
  { key: 'priority', label: 'Criticality', options: [{ value: 'a', label: 'Highest first' }, { value: 'b', label: 'Lowest first' }] },
  { key: 'status', label: 'Live / Test', options: [{ value: 'a', label: 'Live first' }, { value: 'b', label: 'Testing first' }] },
];

/** Every way a rule can be narrowed down. Each group keeps the rules that match any ticked option. */
type FilterKey = 'level' | 'status' | 'record' | 'classification' | 'condition' | 'subject' | 'schedule' | 'area';
type Filters = Record<FilterKey, string[]>;
const NO_FILTERS: Filters = { level: [], status: [], record: [], classification: [], condition: [], subject: [], schedule: [], area: [] };

export function Rules() {
  const rules = useRules();
  const cams = useCameras();
  const alerts = useAlerts();
  const me = useMe();
  const nav = useNavigate();
  const admin = isAdmin(me);
  const live = rules.filter((r) => r.mode === 'live').length;
  const dayAgo = Date.now() - 86400000;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortField; dir: SortDir }>({ key: 'id', dir: 'a' });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [panel, setPanel] = useState(false);
  // The Overview's "rules still in test" opens this list on the Test Only tab: ?tab=test.
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'all' | 'live' | 'test'>(params.get('tab') === 'test' ? 'test' : 'all');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const active = Object.values(filters).reduce((n, v) => n + v.length, 0);

  const camsOf = (r: Rule) => cams.filter((c) => r.cameraIds.includes(c.id));
  const zonesOf = (r: Rule) => [...new Set(camsOf(r).flatMap((c) => c.zones.filter((z) => r.zoneIds.includes(z.id)).map((z) => z.name)))];
  const alertsOf = (r: Rule) => alerts.filter((a) => a.ruleId === r.id && a.at > dayAgo).length;
  const facets = (r: Rule): Record<FilterKey, string[]> => ({
    level: [r.priority],
    status: [r.mode],
    record: [r.qavach],
    classification: r.qavach === 'none' ? [] : [r.classification],
    condition: [r.condition],
    subject: [r.subject],
    schedule: [r.schedule],
    area: [...new Set(camsOf(r).map((c) => c.areaId))],
  });

  const t = q.trim().toLowerCase();
  const shown = rules
    .filter((r) => {
      if (tab !== 'all' && r.mode !== tab) return false;
      const f = facets(r);
      if ((Object.keys(filters) as FilterKey[]).some((k) => filters[k].length && !filters[k].some((v) => f[k].includes(v)))) return false;
      if (!t) return true;
      const text = [r.id, r.name, r.plainText ?? '', describeRule(r, zonesOf(r)), SCHEDULE_LABEL[r.schedule], PRIORITY_NAME[r.priority], r.qavach, ...camsOf(r).map((c) => `${c.id} ${c.name} ${AREAS_BY_ID[c.areaId]?.name ?? ''}`)].join(' ').toLowerCase();
      return text.includes(t);
    })
    .sort((x, y) => {
      const byId = x.id.localeCompare(y.id, undefined, { numeric: true });
      const d = sort.dir === 'a' ? 1 : -1;
      switch (sort.key) {
        case 'name': return d * x.name.localeCompare(y.name) || byId;
        case 'priority': return d * x.priority.localeCompare(y.priority) || byId;
        case 'alerts': return d * (alertsOf(y) - alertsOf(x)) || byId;
        case 'status': return d * ((x.mode === 'live' ? 0 : 1) - (y.mode === 'live' ? 0 : 1)) || byId;
        default: return d * byId;
      }
    });

  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const cur = Math.min(page, pages);
  const rows = shown.slice((cur - 1) * pageSize, cur * pageSize);
  const areaIds = [...new Set(rules.flatMap((r) => camsOf(r).map((c) => c.areaId)))];
  const groups: { key: FilterKey; title: string; options: { value: string; label: string }[] }[] = [
    { key: 'level', title: 'Criticality', options: LEVELS.map((p) => ({ value: p, label: `${p} ${PRIORITY_NAME[p]}` })) },
    { key: 'status', title: 'Status', options: [{ value: 'live', label: 'Live' }, { value: 'test', label: 'Testing' }] },
    { key: 'record', title: 'Reported to QHSE', options: RECORDS.map((v) => ({ value: v, label: v === 'none' ? 'None' : v })) },
    { key: 'classification', title: 'Classification', options: (['Unsafe act', 'Unsafe condition'] as Classification[]).map((v) => ({ value: v, label: v })) },
    { key: 'condition', title: 'Detects', options: (Object.keys(CONDITION_LABEL) as Condition[]).map((c) => ({ value: c, label: CONDITION_LABEL[c][0].toUpperCase() + CONDITION_LABEL[c].slice(1) })) },
    { key: 'subject', title: 'Who or what', options: (Object.keys(SUBJECT_LABEL) as Subject[]).map((s) => ({ value: s, label: SUBJECT_LABEL[s] })) },
    { key: 'schedule', title: 'When', options: (Object.keys(SCHEDULE_LABEL) as Schedule[]).map((s) => ({ value: s, label: SCHEDULE_LABEL[s] })) },
    { key: 'area', title: 'Area', options: areaIds.map((a) => ({ value: a, label: AREAS_BY_ID[a]?.name ?? a })) },
  ];
  const toggle = (k: FilterKey, v: string) => setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  return (
    <div className="page">
      <div className="listbar">
        <div className="tabs rtabs" role="tablist" aria-label="Rules by status">
          {([['all', 'All', rules.length], ['live', 'Live', live], ['test', 'Test Only', rules.length - live]] as const).map(([k, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setPage(1); }}>
              {label}
              <span className="rtabs__n">{n}</span>
            </button>
          ))}
        </div>
        <label className="listbar__search">
          <Icon name="search" size={18} />
          <input className="input input--sm" placeholder="Search rules" aria-label="Search rules" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className={`qact__btn listbar__filter${active ? ' is-on' : ''}`} onClick={() => setPanel(true)}>
          <Icon name="filter" size={22} stroke={2} />
          Filter
          {active > 0 && <span className="listbar__count">{active}</span>}
        </button>
        <div className="listbar__sortcol">
          <CascadeSelect className="listbar__sort" label="Sort rules by" prefix="Sort by:" fields={SORT_FIELDS} value={sort} onChange={setSort} />
          <SearchActions
            onClear={() => {
              setQ('');
              setFilters(NO_FILTERS);
            }}
          />
        </div>
        {admin && (
          <button type="button" className="qact__btn listbar__new" onClick={() => nav('/configuration/rules')}>
            <Icon name="add-circle" size={24} />
            New rule
          </button>
        )}
      </div>

      {panel && (
        <>
          <div className="qset-scrim" onClick={() => setPanel(false)} />
          <aside className="qset" role="dialog" aria-modal="true" aria-label="Filters">
            <strong className="qset__title">Filters</strong>
            <div className="qset__body">
              {groups.map((g) => (
                <div key={g.key} className="qset__group">
                  <div className="qset__sub">{g.title}</div>
                  {g.options.map((o) => (
                    <label key={o.value} className="qset__check">
                      <input type="checkbox" checked={filters[g.key].includes(o.value)} onChange={() => toggle(g.key, o.value)} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="qset__foot">
              <button type="button" className="btn qset__cancel" onClick={() => setFilters(NO_FILTERS)} disabled={!active}>
                Clear all
              </button>
              <button type="button" className="btn" onClick={() => setPanel(false)}>
                Show {shown.length} {shown.length === 1 ? 'rule' : 'rules'}
              </button>
            </div>
          </aside>
        </>
      )}

      <ReadOnlyNote>Only the safety admin creates and changes rules.</ReadOnlyNote>
      <div className="card card--grid">
        <table className="table table--grid">
          <thead>
            <tr>
              <th className="col-id">ID</th>
              <th>Rule</th>
              <th>Cameras</th>
              <th>Criticality</th>
              <th>Live</th>
              <th className="col-act"><span className="sr-only">Edit</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="meta" style={{ textAlign: 'center' }}>
                  No rules match. Change the search or{' '}
                  <button type="button" className="linkbtn" onClick={() => { setQ(''); setFilters(NO_FILTERS); }}>
                    clear the filters
                  </button>
                  .
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const rc = cams.filter((c) => r.cameraIds.includes(c.id));
              const zoneNames = [...new Set(rc.flatMap((c) => c.zones.filter((z) => r.zoneIds.includes(z.id)).map((z) => z.name)))];
              const areas = [...new Set(rc.map((c) => AREAS_BY_ID[c.areaId]?.name.split(' ·')[0]))];
              return (
                <tr key={r.id}>
                  <td className="col-id">
                    <strong>{r.id}</strong>
                  </td>
                  <td style={{ maxWidth: 420 }}>
                    <strong>{r.name}</strong>
                    <div className="meta">
                      {describeRule(r, zoneNames)}
                      {r.schedule !== 'always' && ` · ${SCHEDULE_LABEL[r.schedule]}`}
                    </div>
                  </td>
                  <td>
                    {rc.length}
                    <div className="meta">{areas.join(', ')}</div>
                  </td>
                  <td>
                    <span title={`${r.priority} ${PRIORITY_NAME[r.priority]}`}>
                      <PriorityBadge p={r.priority} short />
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={r.mode === 'live'}
                      disabled={!admin}
                      onChange={(v) => {
                        saveRule({ ...r, mode: v ? 'live' : 'test', updatedAt: Date.now(), updatedBy: me.id });
                        toast(v ? `${r.id} is live: matches now raise alerts` : `${r.id} is in test: matches are logged, no one is told`);
                      }}
                      label={<span className="meta">{r.mode === 'live' ? 'Live' : 'Test'}</span>}
                    />
                  </td>
                  <td className="col-act">
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm rule-edit"
                      onClick={() => nav(`/configuration/rules/${r.id}`)}
                      title={admin ? `Edit ${r.id}` : `View ${r.id}`}
                      aria-label={admin ? `Edit rule ${r.id}` : `View rule ${r.id}`}
                    >
                      <Icon name={admin ? 'edit' : 'eye'} size={18} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pager">
          <span>
            Showing {shown.length === 0 ? 0 : (cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, shown.length)} Of {shown.length} Rules
          </span>
          <span className="spacer" />
          <div className="pager__size">
            <span className="pager__label">Rows Per Page</span>
            <Choice
              id="rules-rows-per-page"
              small
              className="pager__choice"
              label="Rows per page"
              value={pageSize}
              onChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              options={[10, 25, 50].map((n) => ({ value: n, label: String(n) }))}
            />
          </div>
          <button type="button" className="pager__btn" aria-label="Previous page" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>‹</button>
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" className={`pager__btn${n === cur ? ' is-on' : ''}`} aria-current={n === cur ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button>
          ))}
          <button type="button" className="pager__btn" aria-label="Next page" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>›</button>
        </div>
      </div>
    </div>
  );
}
