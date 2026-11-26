import type { Condition, Rule, Subject } from '../data/types';

/** The use cases a rule can be made for, and the ones set aside. Both rule editors, the plain-words draft and the rule lists
 *  read this file, so adding a use case back means moving it from PARKED_USECASES into DOES_WHAT. */

/** What a rule looks for, as people pick it. Fire and smoke is a kind of its own: it is about neither a person nor a vehicle. */
export type Looks = 'person' | 'vehicle' | 'fire-smoke';
export const LOOKS_FOR: Record<Looks, string> = { person: 'Person', vehicle: 'Vehicle', 'fire-smoke': 'Fire & Smoke' };

export interface DoesWhat {
  condition: Condition;
  label: string;
}

/** What each kind of thing can do, in the order the "Does what" list shows. Fire and smoke offers only fire and smoke:
 *  "fire detected" makes no sense for a rule that looks for people. */
export const DOES_WHAT: Record<Looks, DoesWhat[]> = {
  person: [
    { condition: 'enters', label: 'Enters a restricted area' },
    { condition: 'crowd', label: 'People count' },
    { condition: 'gathering', label: 'Crowd gathering' },
    { condition: 'near', label: 'Comes close to a vehicle' },
    { condition: 'phone', label: 'Uses a phone in a restricted zone' },
  ],
  vehicle: [
    { condition: 'enters', label: 'Enters a restricted area' },
    { condition: 'dwells', label: 'Stays too long (dwell time)' },
    { condition: 'speeding', label: 'Over the speed limit' },
    { condition: 'crowd', label: 'Vehicle count' },
  ],
  'fire-smoke': [{ condition: 'smoke', label: 'Fire or smoke detected' }],
};

/** The conditions that can be chosen today. */
export const ACTIVE_CONDITIONS: Condition[] = [...new Set((Object.values(DOES_WHAT).flat() as DoesWhat[]).map((d) => d.condition))];

/** A rule that belongs to a use case still offered. Rules of a parked use case (sample data) stay in the store, so the alerts
 *  raised from them still make sense, but the rule lists and pickers leave them out. */
export const isActiveRule = (r: Pick<Rule, 'condition'>) => ACTIVE_CONDITIONS.includes(r.condition);

export const looksOf = (r: Pick<Rule, 'condition' | 'subject'>): Looks => (r.condition === 'smoke' ? 'fire-smoke' : r.subject === 'vehicle' ? 'vehicle' : 'person');

/** The "Does what" choices for what a rule looks for. A rule being edited that has a condition outside the list (an old one)
 *  keeps showing it, so the box is never blank. */
export function doesWhatOptions(looks: Looks, current?: Condition, labelOf?: (c: Condition) => string): DoesWhat[] {
  const list = DOES_WHAT[looks];
  return current && !list.some((d) => d.condition === current) ? [...list, { condition: current, label: labelOf?.(current) ?? current }] : list;
}

/** The label of a condition in the filters: the same words as the "Does what" list. */
export const conditionLabel = (c: Condition): string => (Object.values(DOES_WHAT).flat() as DoesWhat[]).find((d) => d.condition === c)?.label ?? c;

/** The fields to change when "Looks for" is switched, so the form shows what the service will use. `drawnZones(fire)` gives the
 *  zones drawn on the chosen real cameras for that kind of rule (fire watch areas, or the other zones). */
export function switchLooks(rule: Pick<Rule, 'condition' | 'subject'>, to: Looks, drawnZones: (fire: boolean) => string[]): Partial<Rule> {
  const wasFire = rule.condition === 'smoke';
  if (to === 'fire-smoke') return { condition: 'smoke', subject: 'any' as Subject, durationSec: 0, zoneIds: drawnZones(true), minFrames: 4, fireClasses: 'both' };
  const condition = DOES_WHAT[to].some((d) => d.condition === rule.condition) ? rule.condition : DOES_WHAT[to][0].condition;
  const patch: Partial<Rule> = { condition, subject: to };
  // Leaving fire and smoke: its watch areas are of another kind, and a person or vehicle rule starts with the usual timing.
  if (wasFire) Object.assign(patch, { durationSec: 3, zoneIds: drawnZones(false), minFrames: 3 });
  return patch;
}

/** The field for a count rule: what it is called and what it says. The rule alerts when MORE than this many are inside. */
export const countField = (subject: Subject) => {
  const noun = subject === 'vehicle' ? 'vehicles' : 'people';
  return { label: `Maximum ${noun} allowed`, hint: `Alerts when more than this many ${noun} are inside the zone.` };
};

/** The fields for a speeding rule. The scale is one number for the whole picture, so the speed is a rough reading. */
export const speedFields = {
  limit: 'Speed limit (km/h)',
  across: 'Metres across the picture',
  acrossHint: 'About how wide the road is in the picture, left edge to right. It is the scale for the speed, so the reading is rough, best for vehicles in the middle of the view.',
};

/** The fields for a pedestrian vehicle proximity rule. Distance is in person heights, so it means the same on every camera. */
export const nearFields = {
  label: 'Closer than (person heights)',
  hint: 'Gap between the person and the vehicle, box to box. 1 is about 1.8 m: an arm\'s reach is 0.4, a car length is 2.5.',
  movingOnly: 'Only when the vehicle is moving',
  movingHint: 'Off also alerts for a person beside a parked vehicle, such as someone loading it.',
};

/** The field for a gathering rule: the smallest group, packed together at one place, that raises the alert. */
export const gatherField = {
  label: 'Smallest group',
  hint: 'Alerts when this many people or more stand packed together at one place. People spread out across the zone do not count.',
};

/** Use cases set aside for now: still built in the detection service, not offered in the console. Kept here as the list to
 *  bring back from. The first line of each is how it reads in the rule lists. */
export const PARKED_USECASES: { condition: Condition; label: string; note: string }[] = [
  { condition: 'outside', label: 'Person moves away from the allowed area', note: 'engine OutsideRule' },
  { condition: 'dwells', label: 'Person loitering', note: 'engine IntrusionRule with a long time; offered for vehicles only' },
  { condition: 'crosses', label: 'Line crossing', note: 'engine LineRule' },
  { condition: 'no-ppe', label: 'PPE not worn', note: 'console sample only, no detector' },
  { condition: 'stopped', label: 'Stopped vehicle', note: 'engine StoppedRule' },
  { condition: 'fewer', label: 'Lone worker', note: 'engine CountBelowRule' },
  { condition: 'absent', label: 'Post unattended', note: 'engine CountBelowRule' },
  { condition: 'wrongway', label: 'Wrong-way crossing', note: 'engine WrongWayRule' },
  { condition: 'tailgate', label: 'Tailgating', note: 'engine TailgateRule' },
  { condition: 'running', label: 'Running', note: 'engine RunningRule' },
  { condition: 'abandoned', label: 'Left-behind object', note: 'engine AbandonedRule' },
  { condition: 'down', label: 'Person down', note: 'engine CollapseRule, 11 of 30 falls alerted' },
];
