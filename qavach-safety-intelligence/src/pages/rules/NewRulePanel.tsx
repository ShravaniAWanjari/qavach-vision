import { useState } from 'react';
import { Link } from 'react-router';
import { Choice, Drawer, MultiSelect, PRIORITY_NAME, Seg } from '../../components/ui';
import { AREAS } from '../../data/seed';
import type { Classification, Ppe, Priority, QavachRecordType, Rule, Schedule } from '../../data/types';
import { CONDITION_LABEL, defaultRuleName, describeRule, draftRuleFromText, SCHEDULE_LABEL, type RuleDraft } from '../../lib/qai';
import { nextRuleId, saveRule, toast, useCameras, useMe, useRules } from '../../state/store';
import { CONDITION_DEFAULTS, EXAMPLES, useZoneOptions } from './RuleEditor';
import { countField, doesWhatOptions, gatherField, nearFields, speedFields, LOOKS_FOR, looksOf, switchLooks, type Looks } from '../../lib/usecases';

const DURATIONS = [0, 1, 3, 5, 10, 15, 30, 60, 120, 300, 600];
const secs = (n: number) => (n === 0 ? 'Straight away' : n >= 60 && n % 60 === 0 ? `${n / 60}min` : `${n}s`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Set up a rule without leaving the list: describe it in plain words or pick the fields, then create it. The tuning
 *  (frames, detector certainty, repeat time) starts at the defaults and is changed later in the full rule editor. */
/** `forCamera`: opened while a camera is being set up. The rule can be saved without other cameras, and `onCreated` lets the
 *  camera tick it, so the camera is added to it when the camera itself is saved. */
export function NewRulePanel({ onClose, inline, forCamera, onCreated }: { onClose: () => void; inline?: boolean; forCamera?: string; onCreated?: (rule: Rule) => void }) {
  const cams = useCameras();
  const rules = useRules();
  const me = useMe();
  const [rule, setRule] = useState<Rule>(() => ({
    id: nextRuleId(rules),
    name: '',
    cameraIds: [],
    zoneIds: [],
    subject: 'person',
    condition: 'enters',
    durationSec: 3,
    minFrames: 3,
    minConfidence: 0.25,
    repeatSec: 120,
    minMovePx: 10,
    ppe: [],
    crowdOver: 6,
    schedule: 'always',
    priority: 'P2',
    mode: forCamera ? 'live' : 'test', // a rule made while setting up a camera is meant to work on it, so it starts live
    qavach: 'Observation',
    classification: 'Unsafe act',
    updatedAt: Date.now(),
    updatedBy: me.id,
  }));
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<RuleDraft>();

  // Cameras grouped by work area, in the order of the areas and then by ID, so a new camera sits with its neighbours.
  const cameraOptions = AREAS.flatMap((a) =>
    cams
      .filter((c) => c.areaId === a.id)
      .sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }))
      .map((c) => ({ value: c.id, label: `${c.id} · ${c.name}`, group: a.name })),
  ).concat(cams.filter((c) => !AREAS.some((a) => a.id === c.areaId)).map((c) => ({ value: c.id, label: `${c.id} · ${c.name}`, group: 'Other' })));
  const chosen = cams.filter((c) => rule.cameraIds.includes(c.id));
  const isFire = rule.condition === 'smoke';
  const zoneOptions = useZoneOptions(chosen, isFire);
  const zoneNames = zoneOptions.filter((o) => o.ids.some((id) => rule.zoneIds.includes(id))).map((o) => o.name);
  const set = (p: Partial<Rule>) => setRule({ ...rule, ...p });
  // On a real camera the zones drawn on it are what the rule is for, so they start picked (as in the full editor).
  const drawnZones = (ids: string[], fire: boolean) => cams.filter((c) => ids.includes(c.id) && c.source).flatMap((c) => c.zones.filter((z) => (fire ? z.purpose === 'fire-watch' : !z.purpose.startsWith('fire-'))).map((z) => z.id));

  const runDraft = (t = text) => {
    if (!t.trim()) return;
    const d = draftRuleFromText(t, cams, AREAS);
    setDraft(d);
    setRule({ ...rule, ...d.rule, plainText: t });
  };

  const sentence = `${describeRule(rule, zoneNames)}${rule.schedule !== 'always' ? `, ${SCHEDULE_LABEL[rule.schedule].toLowerCase()}` : ''}`;
  const valid = !!forCamera || rule.cameraIds.length > 0;
  const create = () => {
    const saved = { ...rule, name: rule.name.trim() || defaultRuleName(rule), updatedAt: Date.now(), updatedBy: me.id };
    saveRule(saved);
    onCreated?.(saved);
    toast(`${rule.id} created · ${rule.mode === 'live' ? 'live now' : 'in test: matches are logged, no one is told'}`);
    onClose();
  };

  return (
    <Drawer
      title="New Rule"
      onClose={onClose}
      inline={inline}
      footer={
        <>
          {!valid && <span className="meta" style={{ marginRight: 'auto' }}>Choose at least one camera.</span>}
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={create} disabled={!valid}>
            Create Rule
          </button>
        </>
      }
    >
      <div className="newrule">
        {forCamera && <p className="newrule__forcam">This rule is applied to {forCamera} when you save the camera. Add other cameras below if it should watch them too.</p>}
        <section className="newrule__ai">
          <label className="field__label" htmlFor="nr-text">
            Describe the rule in your own words
          </label>
          <textarea id="nr-text" className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: Alert me when a person moves away from the deck walkway for at least 5 seconds" />
          <div className="newrule__airow">
            <button type="button" className="btn btn--sm" onClick={() => runDraft()} disabled={!text.trim()}>
              Draft the rule
            </button>
            {!draft && <span className="meta">or try one:</span>}
          </div>
          {!draft && (
            <div className="newrule__examples">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="chip chip--outline"
                  onClick={() => {
                    setText(e);
                    runDraft(e);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          {draft && draft.assumed.length > 0 && (
            <div className="newrule__assumed">
              <strong>Assumed, please check</strong>
              <ul>
                {draft.assumed.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <p className="newrule__sentence">
          {sentence} on {chosen.length} camera{chosen.length === 1 ? '' : 's'}, raise a <strong>{rule.priority} {PRIORITY_NAME[rule.priority]}</strong> alert
          {rule.qavach !== 'none' ? ` and a QHSE ${rule.qavach.toLowerCase()}` : ''}.
        </p>

        <div className="field">
          <label htmlFor="nr-name">Rule Name</label>
          <input id="nr-name" className="input" value={rule.name} onChange={(e) => set({ name: e.target.value })} placeholder={defaultRuleName(rule)} />
          <span className="field__hint">Left empty, the rule is called "{defaultRuleName(rule)}".</span>
        </div>

        <MultiSelect
          id="nr-cams"
          label="Cameras"
          placeholder="Choose cameras"
          options={cameraOptions}
          value={rule.cameraIds}
          onChange={(ids) => {
            const keep = rule.zoneIds.filter((z) => ids.some((id) => z.startsWith(`${id}-`)));
            set({ cameraIds: ids, zoneIds: keep.length ? keep : drawnZones(ids, isFire) });
          }}
        />

        <div className="newrule__pair">
          <Choice
            id="nr-subj"
            label="Looks For"
            value={looksOf(rule)}
            options={(Object.keys(LOOKS_FOR) as Looks[]).map((l) => ({ value: l, label: LOOKS_FOR[l] }))}
            onChange={(looks) => set(switchLooks(rule, looks, (fire) => drawnZones(rule.cameraIds, fire)))}
          />
          <Choice
            id="nr-cond"
            label="Does What"
            value={rule.condition}
            options={doesWhatOptions(looksOf(rule), rule.condition, (c) => CONDITION_LABEL[c]).map((d) => ({ value: d.condition, label: d.label }))}
            onChange={(condition) => {
              // Fire and smoke has its own areas and timing; the others start with what the service uses for that condition.
              const { subject: _keep, ...defaults } = CONDITION_DEFAULTS[condition] ?? {};
              set({ condition, ...defaults });
            }}
          />
        </div>

        <MultiSelect
          id="nr-where"
          label={isFire ? 'Watch Areas' : 'Where'}
          placeholder={chosen.length === 0 ? 'Choose cameras first' : zoneOptions.length === 0 ? 'Whole view (no zones drawn)' : 'Whole view'}
          disabled={zoneOptions.length === 0}
          clearable
          options={zoneOptions.map((o) => ({ value: o.name, label: `${o.name} · ${o.ids.length}` }))}
          value={zoneNames}
          onChange={(names) => set({ zoneIds: zoneOptions.filter((o) => names.includes(o.name)).flatMap((o) => o.ids) })}
        />

        {rule.condition === 'no-ppe' && (
          <MultiSelect id="nr-ppe" label="Missing PPE" placeholder="Choose PPE" options={(['helmet', 'vest', 'life jacket'] as Ppe[]).map((p) => ({ value: p, label: cap(p) }))} value={rule.ppe} onChange={(ppe) => set({ ppe })} />
        )}
        {rule.condition === 'crowd' && (
          <div className="field">
            <label htmlFor="nr-crowd">{countField(rule.subject).label}</label>
            <input id="nr-crowd" className="input" type="number" min={1} value={rule.crowdOver} onChange={(e) => set({ crowdOver: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
            <span className="field__hint">{countField(rule.subject).hint}</span>
          </div>
        )}

        {rule.condition === 'near' && (
          <>
            <div className="field">
              <label htmlFor="nr-near">{nearFields.label}</label>
              <input id="nr-near" className="input" type="number" min={0.1} step={0.1} value={rule.nearHeights ?? 1} onChange={(e) => set({ nearHeights: Math.max(0.1, Number(e.target.value) || 1) })} />
              <span className="field__hint">{nearFields.hint}</span>
            </div>
            <div className="field">
              <label htmlFor="nr-near-moving" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input id="nr-near-moving" type="checkbox" checked={rule.nearMovingOnly !== false} onChange={(e) => set({ nearMovingOnly: e.target.checked })} />
                {nearFields.movingOnly}
              </label>
              <span className="field__hint">{nearFields.movingHint}</span>
            </div>
          </>
        )}
        {rule.condition === 'speeding' && (
          <div className="newrule__pair">
            <div className="field">
              <label htmlFor="nr-kmh">{speedFields.limit}</label>
              <input id="nr-kmh" className="input" type="number" min={1} value={rule.speedKmh ?? 30} onChange={(e) => set({ speedKmh: Math.max(1, Number(e.target.value)) })} />
            </div>
            <div className="field">
              <label htmlFor="nr-across">{speedFields.across}</label>
              <input id="nr-across" className="input" type="number" min={1} value={rule.metersAcross ?? 60} onChange={(e) => set({ metersAcross: Math.max(1, Number(e.target.value)) })} />
              <span className="field__hint">{speedFields.acrossHint}</span>
            </div>
          </div>
        )}
        {rule.condition === 'gathering' && (
          <div className="field">
            <label htmlFor="nr-gather">{gatherField.label}</label>
            <input id="nr-gather" className="input" type="number" min={3} value={rule.minPeople ?? 5} onChange={(e) => set({ minPeople: Math.max(3, Math.round(Number(e.target.value)) || 3) })} />
            <span className="field__hint">{gatherField.hint}</span>
          </div>
        )}

        <div className="newrule__pair">
          {!isFire && (
            <Choice id="nr-dur" label="For At Least" value={rule.durationSec} onChange={(durationSec) => set({ durationSec })} options={[...new Set([...DURATIONS, rule.durationSec])].sort((a, b) => a - b).map((n) => ({ value: n, label: secs(n) }))} />
          )}
          <Choice id="nr-when" label="When" value={rule.schedule} onChange={(schedule) => set({ schedule })} options={(Object.keys(SCHEDULE_LABEL) as Schedule[]).map((s) => ({ value: s, label: SCHEDULE_LABEL[s] }))} />
        </div>

        <div className="field">
          <span className="field__label">Alert Criticality</span>
          <Seg label="Alert criticality" value={rule.priority} onChange={(priority) => set({ priority })} options={(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => ({ value: p, label: `${p} ${PRIORITY_NAME[p]}` }))} />
          <span className="field__hint">
            The criticality decides who is alerted and how. <Link to="/configuration/alerts" onClick={onClose}>See alert configuration</Link>
          </span>
        </div>

        <div className="newrule__pair">
          <Choice
            id="nr-q"
            label="Reported to QHSE"
            value={rule.qavach}
            onChange={(qavach) => set({ qavach })}
            options={[...(['Incident', 'Observation', 'Near miss'] as QavachRecordType[]).map((v) => ({ value: v as QavachRecordType | 'none', label: v })), { value: 'none' as QavachRecordType | 'none', label: "Don't create one" }]}
          />
          <Choice id="nr-class" label="Classification" value={rule.classification} onChange={(classification) => set({ classification })} options={(['Unsafe act', 'Unsafe condition'] as Classification[]).map((v) => ({ value: v, label: v }))} />
        </div>

        <div className="field">
          <span className="field__label">Start As</span>
          <Seg
            label="Start as"
            value={rule.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: 'test', label: 'Test only' },
              { value: 'live', label: 'Live' },
            ]}
          />
          <span className="field__hint">Test only raises alerts here without telling anyone, so false alarms can be checked first.</span>
        </div>
      </div>
    </Drawer>
  );
}
