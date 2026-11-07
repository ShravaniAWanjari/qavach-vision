import { useState } from 'react';
import { ReadOnlyNote } from '../components/Shell';
import { CHANNEL, Choice, Drawer, MultiSelect, NumberField, PRIORITY_NAME, PriorityBadge } from '../components/ui';
import type { Channel, Policy, Role } from '../data/types';
import { isAdmin, savePolicies, toast, useMe, usePolicies } from '../state/store';
import './notifications.css';

const ROLES: Role[] = ['Control room operator', 'Shift supervisor', 'HSE manager', 'Terminal manager'];
const CHANNELS: Channel[] = ['wall', 'push', 'sms', 'whatsapp', 'email', 'call'];

const WALL_OPTIONS = [
  { value: 'takeover' as const, label: 'Takes over a tile' },
  { value: 'sound' as const, label: 'Alarm sound' },
];

/** Alert Configuration as a side panel: one block per alert level, saved together. */
export function AlertConfigPanel({ onClose, inline }: { onClose: () => void; inline?: boolean }) {
  const saved = usePolicies();
  const me = useMe();
  const admin = isAdmin(me);
  const [draft, setDraft] = useState<Policy[]>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const cancel = () => {
    setDraft(saved);
    onClose();
  };
  const set = (p: Policy, patch: Partial<Policy>) => setDraft(draft.map((x) => (x.priority === p.priority ? { ...x, ...patch } : x)));

  return (
    <Drawer
      title="Alert Configuration"
      sub="Who is notified, how, and what happens if nobody responds, for each alert level"
      onClose={onClose}
      inline={inline}
      footer={
        admin ? (
          <>
            {dirty && <span className="acfg__dirty" style={{ marginRight: 'auto' }}>Unsaved changes</span>}
            <button type="button" className="btn btn--secondary" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={!dirty}
              onClick={() => {
                savePolicies(draft);
                toast('Alert configuration saved. New and open alerts follow it from now on.');
                onClose();
              }}
            >
              Save
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <ReadOnlyNote>Only the safety admin changes the alert configuration.</ReadOnlyNote>
      <fieldset className="plain acpanel" disabled={!admin}>
        {draft.map((p) => {
          const id = (k: string) => `${k}-${p.priority}`;
          return (
            <section key={p.priority} className="acpanel__level">
              <div className="acpanel__head">
                <PriorityBadge p={p.priority} />
                <h2>{PRIORITY_NAME[p.priority]} alerts</h2>
              </div>

              <div className="acpanel__fields">
                <MultiSelect
                  id={id('via')}
                  label="Notify Via"
                  placeholder="No channels"
                  options={CHANNELS.map((c) => ({ value: c, label: CHANNEL[c].label, icon: CHANNEL[c].icon }))}
                  value={p.channels}
                  onChange={(channels) => set(p, { channels })}
                />
                <MultiSelect
                  id={id('who')}
                  label="Notify First"
                  placeholder="No one"
                  options={ROLES.map((r) => ({ value: r, label: r }))}
                  value={p.notify}
                  onChange={(notify) => set(p, { notify })}
                />
                <Choice id={id('ack')} label="Respond Within" value={p.ackWithinMin} onChange={(ackWithinMin) => set(p, { ackWithinMin })} options={[1, 2, 5, 10, 15, 30, 60].map((m) => ({ value: m, label: `${m}min` }))} />
                <Choice
                  id={id('esc')}
                  label="Then Escalate To"
                  value={p.escalateTo}
                  onChange={(escalateTo) => set(p, { escalateTo })}
                  options={[{ value: 'none' as Role | 'none', label: 'No one' }, ...ROLES.map((r) => ({ value: r as Role | 'none', label: r }))]}
                />
                <NumberField id={id('rem')} label="Remind Every" min={0} max={60} value={p.remindEveryMin} onChange={(remindEveryMin) => set(p, { remindEveryMin })} unit={(n) => (n === 0 ? 'off' : 'min')} />
                <NumberField
                  id={id('remmax')}
                  label="At Most"
                  min={1}
                  max={p.priority === 'P1' ? 3 : 5}
                  value={Math.min(p.remindMax ?? 3, p.priority === 'P1' ? 3 : 5)}
                  onChange={(remindMax) => set(p, { remindMax })}
                  unit={(n) => (n === 1 ? 'reminder' : 'reminders')}
                  disabled={p.remindEveryMin === 0}
                />
                <MultiSelect
                  id={id('wall')}
                  label="On The Video Wall"
                  placeholder="Off"
                  options={WALL_OPTIONS}
                  value={WALL_OPTIONS.filter((o) => (o.value === 'takeover' ? p.wallTakeover : p.sound)).map((o) => o.value)}
                  onChange={(v) => set(p, { wallTakeover: v.includes('takeover'), sound: v.includes('sound') })}
                />
                <Choice
                  id={id('qav')}
                  label="Reported to QHSE"
                  value={p.qavach}
                  onChange={(qavach) => set(p, { qavach })}
                  options={[
                    { value: 'on-acknowledge' as Policy['qavach'], label: 'On acknowledgement' },
                    { value: 'reviewer-decides' as Policy['qavach'], label: 'A reviewer decides' },
                    { value: 'never' as Policy['qavach'], label: 'Never raised' },
                  ]}
                />
              </div>
            </section>
          );
        })}
      </fieldset>
    </Drawer>
  );
}
