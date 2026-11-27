export type Pt = [number, number]; // % of the camera view, so zones survive any display size

export type SceneKind = 'quay' | 'deck' | 'yard' | 'reefer' | 'gate' | 'workshop' | 'hazmat' | 'perimeter';

export interface Area {
  id: string;
  name: string;
  scene: SceneKind;
  /** High-operational areas are pinned on walls by default. */
  highOps: boolean;
}

/** `fire-watch` and `fire-ignore` are for fire and smoke rules, which have no restricted areas: a watch area is where fire
 *  or smoke matters, an ignore area is where it is normal (a steam vent, an exhaust stack, a flare). */
export type ZonePurpose = 'walkway' | 'restricted' | 'exclusion' | 'deck-edge' | 'work-area' | 'vehicle-lane' | 'line' | 'fire-watch' | 'fire-ignore';

export interface Zone {
  id: string;
  name: string;
  purpose: ZonePurpose;
  kind: 'polygon' | 'line';
  points: Pt[];
}

export type CameraStatus = 'online' | 'degraded' | 'offline';

/** Where a real camera's pictures come from. Cameras without one show the drawn sample scene. */
export interface CameraSource {
  kind: 'link' | 'upload';
  /** A YouTube live link or a stream address. Never holds a password. */
  url?: string;
  /** Stream user name (not secret). The password is typed once, kept by the service in memory, and never stored here. */
  user?: string;
  uploadId?: string;
  fileName?: string;
  /** A browser-playable address of the same camera from a media server (HLS .m3u8, or a video file), for watching it live
   *  without the detection service making pictures. The service still analyses `url`. */
  viewUrl?: string;
  /** Uploaded video: analyse every frame, so nothing is skipped; the video plays slower than real time if the service cannot keep up. */
  everyFrame?: boolean;
  /** The still frame taken when the connection was tested; zones are drawn on it. Relative to the detection service. */
  frameUrl?: string;
  width?: number;
  height?: number;
  live?: boolean;
  title?: string;
}

export interface Camera {
  id: string;
  /** Where the camera is, as people say it ("Berth 2 · deck port side"). Shown as the camera location. */
  name: string;
  /** The work area it covers. */
  areaId: string;
  /** The department that owns it. Unset means the work area's usual department. */
  department?: string;
  scene: SceneKind;
  /** Varies the sample picture so cameras in one area don't look identical. */
  variant: number;
  status: CameraStatus;
  /** When the camera went offline or degraded (unset while it is online). */
  statusSince?: number;
  stream: string;
  make: string;
  resolution: string;
  fps: number;
  zones: Zone[];
  addedAt: number;
  addedBy: string;
  source?: CameraSource;
}

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export type Subject = 'person' | 'vehicle' | 'any';

export type Condition =
  | 'enters' // enters the zone
  | 'outside' // moves away from / is outside the zone
  | 'dwells' // stays inside the zone
  | 'crosses' // crosses a line
  | 'no-ppe' // inside the zone without the required PPE
  | 'crowd' // more than N in the zone
  | 'gathering' // a group of at least N people packed together
  | 'smoke' // smoke or flame
  | 'stopped' // vehicle stopped
  | 'near' // a person close to a moving vehicle
  | 'fewer' // fewer than N people in the zone (a lone worker)
  | 'absent' // nobody in the zone
  | 'wrongway' // crosses a line against the allowed direction
  | 'tailgate' // follows another person through a line
  | 'speeding' // a vehicle over the speed limit
  | 'running' // a person running
  | 'abandoned' // an object left behind
  | 'phone' // a phone in use
  | 'down'; // a person fell and stays down

export type Ppe = 'helmet' | 'vest' | 'life jacket';

export type Schedule = 'always' | 'day' | 'night' | 'vessel-ops';

export type QavachRecordType = 'Incident' | 'Observation' | 'Near miss';
export type Classification = 'Unsafe act' | 'Unsafe condition';

export interface Rule {
  id: string;
  name: string;
  /** What the admin typed, if the rule was drafted from plain words. */
  plainText?: string;
  cameraIds: string[];
  /** Zone ids across the chosen cameras. Empty means the whole view. */
  zoneIds: string[];
  subject: Subject;
  condition: Condition;
  durationSec: number;
  /** Detection steadiness for "enters the zone" on a real camera. Defaults: 3 frames, 25 %, 120s, 10px. */
  minFrames?: number;
  minConfidence?: number;
  repeatSec?: number;
  /** The tracked person's feet must have moved this many pixels (a static pole the detector calls a person never does). 0 turns it off. */
  minMovePx?: number;
  /** Fire and smoke rules: which of the two to look for. For them `minFrames` is how many of the last 8 frames it must be seen in. */
  fireClasses?: 'both' | 'fire' | 'smoke';
  ppe: Ppe[];
  crowdOver: number;
  /** Lone worker: alert when fewer than this many people (at least one) are in the zone. */
  minPeople?: number;
  /** Crowd gathering: how close people stand to be one group, in body heights (0.5 by default; about 1 for a large, loose crowd). */
  gatherReach?: number;
  /** Near a vehicle: how close, in pixels at 1280 wide, counts as near. */
  nearPx?: number;
  /** Pedestrian vehicle proximity: how close a person is to a vehicle, in person heights (box to box). Replaces nearPx. */
  nearHeights?: number;
  /** false: a person beside a parked vehicle counts too (default true: only a moving vehicle). */
  nearMovingOnly?: boolean;
  /** Phone use: how sure the detector must be that the object is a phone (0 to 1). Look-alikes such as binoculars and radios score low. */
  phoneConfidence?: number;
  /** Speeding: the limit in km/h, and about how many metres the picture spans where vehicles drive (gives the scale). */
  speedKmh?: number;
  metersAcross?: number;
  /** Wrong way: the allowed direction across the line, 1 right of the line as drawn (first point to last), -1 left. */
  allowedDir?: 1 | -1;
  /** Tailgating: a second person within this many seconds of the first. */
  gapSec?: number;
  /** Left-behind object: someone this close (pixels at 1280 wide) still counts as with it. */
  ownerPx?: number;
  /** Running: pace in body heights a second (walking is about 0.8). */
  runSpeed?: number;
  schedule: Schedule;
  priority: Priority;
  mode: 'live' | 'test';
  qavach: QavachRecordType | 'none';
  classification: Classification;
  updatedAt: number;
  updatedBy: string;
}

export type AlertState = 'new' | 'escalated' | 'acknowledged' | 'resolved' | 'false-alarm';

export type Channel = 'wall' | 'push' | 'sms' | 'whatsapp' | 'email' | 'call';

export interface Delivery {
  at: number;
  to: string; // user id
  channel: Channel;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  reason: 'alert' | 'escalation' | 'reminder';
}

export interface ActivityEntry {
  at: number;
  text: string;
  actor: string;
}

export interface QavachRecord {
  type: QavachRecordType;
  ref: string;
  title: string;
  description: string;
  classification: Classification;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  immediateAction: string;
  createdBy: string;
  at: number;
  /** 'auto' when the notification policy raised it on acknowledgement. */
  source: 'manual' | 'auto' | 'mobile';
}

export interface Alert {
  id: string;
  ruleId: string;
  cameraId: string;
  zoneId?: string;
  priority: Priority;
  title: string;
  detail: string;
  at: number;
  state: AlertState;
  /** Detection box, % of the camera view. */
  box: [number, number, number, number];
  confidence: number;
  /** The frame the alert was raised on (real cameras), relative to the detection service. */
  snapshot?: string;
  /** A short clip of the incident saved with the alert (real cameras), relative to the detection service. */
  clip?: string;
  /** The detection service's id for the event, so an alert is never created twice. */
  eventId?: string;
  /** Detections of the same rule on the same camera while this alert was still open; they add to it, not to the list. */
  repeats?: number;
  /** When the latest of those repeat detections happened. */
  lastAt?: number;
  ackBy?: string;
  ackAt?: number;
  ackVia?: 'wall' | 'console' | 'mobile';
  assignee?: string;
  escalatedTo?: string;
  deliveries: Delivery[];
  activity: ActivityEntry[];
  qavach?: QavachRecord;
}

export type PinnedLayout = '1' | '2x2' | '1+5' | '2x3' | '3x3';

export interface Wall {
  id: string;
  name: string;
  teamId: string;
  /** Share of the wall width given to pinned cameras; 100 means nothing rolls, 0 means everything does. */
  pinnedShare: 0 | 60 | 70 | 80 | 100;
  pinnedLayout: PinnedLayout;
  pinned: (string | null)[];
  rollingTiles: 3 | 4 | 6 | 9 | 16;
  rotation: string[];
  rotateSec: 10 | 15 | 30 | 60;
  /** Keeps the last pinned slot on whichever camera is busiest right now. */
  autoPinBusy: boolean;
  /** A camera with an open alert jumps into the first pinned slot until someone acknowledges it. */
  alertTakeover: boolean;
}

export type Role = 'Safety admin' | 'Control room operator' | 'Shift supervisor' | 'HSE manager' | 'Terminal manager';

export interface Team {
  id: string;
  name: string;
  areaIds: string[];
}

export interface User {
  id: string;
  name: string;
  role: Role;
  teamId: string;
  phone: string;
}

export interface Policy {
  priority: Priority;
  label: string;
  channels: Channel[];
  /** Roles told first; the alert goes to the people in that role on the camera's team. */
  notify: Role[];
  /** Seconds to review the alert (first look), and seconds to report it to QHSE. 0 reporting time: not reported. */
  reviewWithinSec: number;
  reportWithinSec: number;
  escalateTo: Role | 'none';
  remindEveryMin: number;
  /** How many reminders at most: up to 3 for P1, up to 5 for the other levels. Older saved settings have none: 3. */
  remindMax?: number;
  /** When the Qavach record is raised. */
  qavach: 'on-acknowledge' | 'reviewer-decides' | 'never';
  wallTakeover: boolean;
  sound: boolean;
}
