import { useState } from 'react';
import { Link } from 'react-router';
import { Choice, Drawer, MultiSelect, PRIORITY_NAME, Seg } from '../../components/ui';
import { AREAS } from '../../data/seed';
import type { Classification, Condition, Ppe, Priority, QavachRecordType, Rule, Schedule, Subject } from '../../data/types';
import { CONDITION_LABEL, describeRule, draftRuleFromText, SCHEDULE_LABEL, type RuleDraft } from '../../lib/qai';
import { nextRuleId, saveRule, toast, useCameras, useMe, useRules } from '../../state/store';
import { EXAMPLES, useZoneOptions } from './RuleEditor';

const LOOK_FOR: Record<Subject, string> = { person: 'Person', vehicle: 'Vehicle', any: 'Person or vehicle' };
const DURATIONS = [0, 1, 3, 5, 10, 15, 30, 60, 120, 300, 600];
const secs = (n: number) => (n === 0 ? 'Straight away' : n >= 60 && n % 60 === 0 ? `${n / 60} min` : `${n} s`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Set up a rule without leaving the list: describe it in plain words or pick the fields, then create it. The tuning
 *  (frames, detector certainty, repeat time) starts at the defaults and is changed later in the full rule editor. */
export function NewRulePanel({ onClose }: { onClose: () => void }) {
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
    mode: 'test',
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
  const valid = rule.cameraIds.length > 0;
  const create = () => {
    saveRule({ ...rule, name: rule.name.trim() || sentence, updatedAt: Date.now(), updatedBy: me.id });
    toast(`${rule.id} created · ${rule.mode === 'live' ? 'live now' : 'in test: matches are logged, no one is told'}`);
    onClose();
  };

  return (
    <Drawer
      title="New Rule"
      onClose={onClose}
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
          {rule.qavach !== 'none' ? ` and a Qavach ${rule.qavach.toLowerCase()}` : ''}.
        </p>

        <div className="field">
          <label htmlFor="nr-name">Rule Name</label>
          <input id="nr-name" className="input" value={rule.name} onChange={(e) => set({ name: e.target.value })} placeholder="Named from the rule if left empty" />
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
          {!isFire && (
            <Choice id="nr-subj" label="Look For" value={rule.subject} onChange={(subject) => set({ subject })} options={(Object.keys(LOOK_FOR) as Subject[]).map((s) => ({ value: s, label: LOOK_FOR[s] }))} />
          )}
          <Choice
            id="nr-cond"
            label="Does What"
            value={rule.condition}
            options={(Object.keys(CONDITION_LABEL) as Condition[]).map((c) => ({ value: c, label: cap(CONDITION_LABEL[c].replace('N', String(rule.crowdOver))) }))}
            onChange={(condition) => {
              // Fire and smoke is about neither a person nor a vehicle, and its areas are of a different kind.
              if (condition === 'smoke') set({ condition, subject: 'any', durationSec: 0, zoneIds: drawnZones(rule.cameraIds, true), minFrames: 4, fireClasses: 'both' });
              else if (isFire) set({ condition, subject: 'person', durationSec: 3, zoneIds: drawnZones(rule.cameraIds, false), minFrames: 3 });
              else set({ condition });
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
          <Choice id="nr-crowd" label="More Than" value={rule.crowdOver} onChange={(crowdOver) => set({ crowdOver })} options={[...new Set([2, 3, 4, 5, 6, 8, 10, 15, 20, rule.crowdOver])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${n} people` }))} />
        )}
        {isFire && (
          <Choice
            id="nr-look"
            label="Look For"
            value={rule.fireClasses ?? 'both'}
            onChange={(fireClasses) => set({ fireClasses })}
            options={[
              { value: 'both' as const, label: 'Fire and smoke' },
              { value: 'fire' as const, label: 'Fire only' },
              { value: 'smoke' as const, label: 'Smoke only' },
            ]}
          />
        )}

        <div className="newrule__pair">
          {!isFire && (
            <Choice id="nr-dur" label="For At Least" value={rule.durationSec} onChange={(durationSec) => set({ durationSec })} options={[...new Set([...DURATIONS, rule.durationSec])].sort((a, b) => a - b).map((n) => ({ value: n, label: secs(n) }))} />
          )}
          <Choice id="nr-when" label="When" value={rule.schedule} onChange={(schedule) => set({ schedule })} options={(Object.keys(SCHEDULE_LABEL) as Schedule[]).map((s) => ({ value: s, label: SCHEDULE_LABEL[s] }))} />
        </div>

        <div className="field">
          <span className="field__label">Alert Level</span>
          <Seg label="Alert level" value={rule.priority} onChange={(priority) => set({ priority })} options={(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => ({ value: p, label: `${p} ${PRIORITY_NAME[p]}` }))} />
          <span className="field__hint">
            The level decides who is alerted and how. <Link to="/notifications" onClick={onClose}>See alert configuration</Link>
          </span>
        </div>

        <div className="newrule__pair">
          <Choice
            id="nr-q"
            label="Qavach Record"
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
