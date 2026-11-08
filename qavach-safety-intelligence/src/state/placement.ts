import { TEAMS } from '../data/seed';
import type { Camera, Rule, Wall } from '../data/types';

const TEAM_AREAS = new Map(TEAMS.map((t) => [t.id, t.areaIds]));

/** The walls a new camera joins without anyone ticking boxes: those of the teams that cover its work area. Rules are not
 *  suggested: the admin picks the rules in the camera set-up, or makes a new one. */
export function placementFor(cam: Camera, walls: Wall[]) {
  return { walls: walls.filter((w) => TEAM_AREAS.get(w.teamId)?.includes(cam.areaId)).map((w) => w.id) };
}

/** Puts a camera on or off a rule, with the zones that go with it. */
export function setCameraOnRule(rule: Rule, cam: Camera, on: boolean, zoneIds: string[]): Rule {
  const rest = rule.cameraIds.filter((id) => id !== cam.id);
  const zones = rule.zoneIds.filter((z) => !cam.zones.some((cz) => cz.id === z));
  return on ? { ...rule, cameraIds: [...rest, cam.id], zoneIds: [...zones, ...zoneIds] } : { ...rule, cameraIds: rest, zoneIds: zones };
}
