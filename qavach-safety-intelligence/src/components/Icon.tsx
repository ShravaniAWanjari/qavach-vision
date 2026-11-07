import { assetUrl } from '../lib/assets';
// Stroke icons on a 24px grid, from the Qavach AI-native icon set
// (qavach-ai/src/app/ui/icon.ts), plus a few for walls and zones in the same style.
const ICONS = {
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  bell: '<path d="M6.5 16V11a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z"/><path d="M10 20.5h4"/>',
  warning: '<path d="M10.3 4.6 3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8v.2"/>',
  spark: '<path d="M11 3.5c.7 4.4 2.6 6.3 7 7-4.4.7-6.3 2.6-7 7-.7-4.4-2.6-6.3-7-7 4.4-.7 6.3-2.6 7-7z"/><path d="M18.5 15c.3 1.8 1.1 2.6 2.9 2.9-1.8.3-2.6 1.1-2.9 2.9-.3-1.8-1.1-2.6-2.9-2.9 1.8-.3 2.6-1.1 2.9-2.9z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="5" cy="6.5" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="17.5" r="1" fill="currentColor"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"/><path d="M8.5 4.5v15M13.5 4.5v15"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  download: '<path d="M12 4.5v11M7.5 11 12 15.5 16.5 11"/><path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  wall: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M12 4.5v12M3 10.5h9"/><path d="M8.5 20h7M12 16.5V20"/>',
  'camera-plus': '<path d="M13.5 4.5h-4.2L7.8 7H5.5A1.5 1.5 0 0 0 4 8.5v9A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V12"/><circle cx="12" cy="12.8" r="3.3"/><path d="M18 3v6M15 6h6"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.5h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  cctv: '<path d="M9.1 4.2 21 9.6 16.4 14.4 6.4 9.8z"/><path d="M17 14.1l3.2 1.4L22 10.8l-1.1-.5"/><path d="M8.4 11.1 7.6 12.9l4.6 2.2 1.1-2.2"/><path d="M10 14.8 8.2 16.4a1 1 0 0 1-.8.4H4.9"/><path d="M2 13.5 4.9 14v5.4L2 19.9z"/>',
  rule: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h7.5a3 3 0 0 0 0-6h-7a3 3 0 0 1 0-6H16"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  incident: '<path d="M10.3 4.6 3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8v.2"/>',
  pin: '<path d="M9 4.5h6l-1 5 3 3v1.5H7v-1.5l3-3z"/><path d="M12 14v6"/>',
  unpin: '<path d="M9 4.5h6l-1 5 3 3v1.5H7v-1.5l3-3z"/><path d="M12 14v6M4 4l16 16"/>',
  polygon: '<path d="M5 8.5 11 4l8 4.5-2 10H7z"/><circle cx="5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="11" cy="4" r="1.4" fill="currentColor"/><circle cx="19" cy="8.5" r="1.4" fill="currentColor"/><circle cx="17" cy="18.5" r="1.4" fill="currentColor"/><circle cx="7" cy="18.5" r="1.4" fill="currentColor"/>',
  line: '<path d="M5 18 19 6"/><circle cx="5" cy="18" r="1.6" fill="currentColor"/><circle cx="19" cy="6" r="1.6" fill="currentColor"/>',
  cursor: '<path d="M6 4l12 6.5-5.5 1.5L10.5 18z"/>',
  layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M15 4.5v15M15 12h5.5"/>',
  rotate: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  expand: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  'chevron-down': '<path d="m7 10 5 5 5-5"/>',
  'chevron-right': '<path d="m10 7 5 5-5 5"/>',
  'chevron-left': '<path d="m14 7-5 5 5 5"/>',
  'arrow-right': '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  'arrow-left': '<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  'add-circle': '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7v10M7 12h10" stroke="var(--c-white)" stroke-width="2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5.5 12.5 4 4 9-9.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="1.8"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
  location: '<path d="M12 20.5s-6.2-5.3-6.2-10.4a6.2 6.2 0 0 1 12.4 0c0 5.1-6.2 10.4-6.2 10.4z"/><circle cx="12" cy="10" r="2.3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  flame: '<path d="M12 3.3c.5 3.2-1.9 4.7-3.4 6.8-1.5 2.2-1.5 5.1.4 7 1.9 1.9 5.2 1.9 7-.2 1.5-1.8 1.4-4.2-.3-6.4-.3 1.4-1 2.2-2 2.6.7-3.7-.3-6.6-1.7-9.8z"/><path d="M12 20.4c-1.3 0-2.2-.9-2.2-2.1 0-1.2 1.1-2 2.2-3.2 1.1 1.2 2.2 2 2.2 3.2 0 1.2-.9 2.1-2.2 2.1z"/>',
  truck: '<path d="M2.8 7.2h10.6v9.1H2.8z"/><path d="M13.4 10.2h4.1l3.2 3.2v2.9h-7.3"/><circle cx="7" cy="17.6" r="1.9"/><circle cx="17" cy="17.6" r="1.9"/>',
  walker: '<circle cx="13" cy="4.6" r="1.8"/><path d="M12.2 8.2 11 14.2M12.2 9.4 9 12M12.2 9.4l3.4 2.6M11 14.2l-2.6 5.6M11 14.2l3.2 2.4.5 4"/>',
  hardhat: '<path d="M5.5 16a6.5 6.5 0 0 1 13 0"/><path d="M3.5 16h17M12 6.3v2.7M4.6 19h14.8"/>',
  cast: '<path d="M3.5 18.4a2.6 2.6 0 0 1 2.6 2.1M3.5 14.6a6.4 6.4 0 0 1 6.3 5.9M3.5 10.8a10.2 10.2 0 0 1 10 9.7"/><path d="M3.5 7.5V6A2 2 0 0 1 5.5 4h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H15"/>',
  'arrow-up': '<path d="M12 19.5v-15M6.5 10 12 4.5 17.5 10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.7-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15 6.3a3 3 0 0 1 0 5.4M17 14.6c1.9.5 3.1 2 3.5 4.4"/>',
  phone: '<path d="M5.5 4.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C10.6 19.5 4.5 13.4 4 6.1A1.5 1.5 0 0 1 5.5 4.5z"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M11 17.5h2"/>',
  chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5a2 2 0 0 1-1.5-2z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  sms: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5a2 2 0 0 1-1.5-2z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke-width="2.4"/>',
  edit: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="m12.5 7.5 4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13"/><path d="M17.5 14v4.5A1.5 1.5 0 0 1 16 20H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.2"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
  logout: '<path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/>',
  doc: '<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5v5h5M9 13h6M9 16.5h4"/>',
  send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  map: '<path d="m9 4.5-5.5 2v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  layers: '<path d="M12 4 3.5 8.5 12 13l8.5-4.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
  wifi: '<path d="M4 9.5a12 12 0 0 1 16 0M7 12.8a7.5 7.5 0 0 1 10 0M10 16a3 3 0 0 1 4 0"/><path d="M12 19h.01" stroke-width="2.4"/>',
  helmet: '<path d="M3.5 17.5h17"/><path d="M5 17.5a7 7 0 0 1 14 0"/><path d="M10 10.8V7h4v3.8"/>',
  drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.6"/>',
  activity: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
  // Qavach navigation (sidebar, header and the Autonomous Safety menu)
  dash: '<rect x="3" y="4" width="18" height="12.5" rx="1.5"/><path d="M8 20h8M12 16.5V20M7 13.5v-3M11 13.5V8.5M15 13.5v-2M18 13.5V9"/>',
  report: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19M9 17v-3M12 17v-5M15 17v-2.5"/>',
  autonomous: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 16 3-8 3 8M9 13.5h4"/><path d="M17 8v3.5" />',
  risk: '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/><path d="M14.5 15.5h5M14.5 18.5h5M9.5 7h5M7 9.5v5"/>',
  unsafe: '<path d="M7 4.5h10v16H7z"/><path d="M10 4.5V3.5h4v1M9.5 10h5M9.5 13h5M9.5 16h3"/>',
  observe: '<circle cx="9.5" cy="9.5" r="5"/><path d="m13.5 13.5 6 6M7.5 9h.01M11.5 9h.01M7.5 11.5c1 1 3 1 4 0"/>',
  incmgmt: '<circle cx="7.5" cy="16.5" r="3.5"/><path d="M7.5 14.5v2h2M14 5.5h6M14 9.5h6M12 4.5l-1.5 2L9 5"/><path d="M15.5 14h4.5v6h-4.5z"/>',
  inspect: '<rect x="3.5" y="4.5" width="17" height="13" rx="1.5"/><path d="M3.5 8.5h17"/><circle cx="12.5" cy="13.5" r="3"/><path d="m15 16 3 3"/>',
  headset: '<path d="M5 14v-2.5a7 7 0 0 1 14 0V14"/><rect x="3.5" y="13" width="3.5" height="5" rx="1.2"/><rect x="17" y="13" width="3.5" height="5" rx="1.2"/><path d="M19 18c0 1.8-1.5 2.5-4 2.5"/>',
  translate: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M7 15.5 9.2 9l2.2 6.5M7.8 13.5h2.8M13.5 9h4l-4 6.5h4"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.7a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2-2.5 3.7M12 17.5v.01"/>',
  youtube: '<rect x="3" y="6" width="18" height="12" rx="3.5"/><path d="m10.5 9.3 4 2.7-4 2.7z" fill="currentColor"/>',
  power: '<path d="M12 3.5v8"/><path d="M7.5 6.5a7.5 7.5 0 1 0 9 0"/>',
  uin: '<rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M7.5 8h9M7.5 11.5h9M7.5 15h5"/><circle cx="17" cy="16" r="2.3"/><path d="m18.7 17.7 2 2"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m12 6.5 1.6 4 3.9 1.5-3.9 1.5L12 17.5l-1.6-4-3.9-1.5 3.9-1.5z"/>',
  analyzer: '<circle cx="11" cy="11" r="7"/><path d="m16.2 16.2 4.3 4.3M8 14v-3M11 14V8M14 14v-2"/>',
  intel: '<rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/><circle cx="12" cy="10" r="2.5"/><path d="M12 6.5v1M12 12.5v1M8.5 10h1M14.5 10h1"/>',
  listing: '<path d="M7 4.5h10v16H7z"/><path d="M10 4.5V3.5h4v1M9.5 9h5M9.5 12h5M9.5 15h5"/>',
  review: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><circle cx="12" cy="14" r="2.5"/><path d="m14 16 2 2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  rca: '<circle cx="12" cy="5.5" r="2"/><circle cx="5.5" cy="16" r="2"/><circle cx="18.5" cy="16" r="2"/><circle cx="12" cy="19.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 7.5v3M10.8 13l-3.7 2M13.2 13l3.7 2M12 13.5V18"/>',
  wheel: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3.5v6.3M12 14.2v6.3M3.5 12h6.3M14.2 12h6.3M6 6l4.4 4.4M13.6 13.6 18 18M18 6l-4.4 4.4M10.4 13.6 6 18"/>',
  workflow: '<circle cx="6" cy="5.5" r="1.8"/><circle cx="12" cy="5.5" r="1.8"/><circle cx="18" cy="5.5" r="1.8"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="1" fill="currentColor"/><path d="M12 15v5.5M8 20.5h8"/>',
  stack: '<rect x="3.5" y="7.5" width="12.5" height="11" rx="1.5"/><path d="M7 7.5V5.5h12.5v11H16"/>',
  config: '<circle cx="9.5" cy="10.5" r="3"/><path d="M9.5 5.5v1.5M9.5 14v1.5M4.5 10.5H6M13 10.5h1.5M6 7l1 1M12 13l1 1M13 7l-1 1M7 13l-1 1"/><circle cx="17" cy="17" r="2"/><path d="M17 13.8v1M17 19.2v1M13.8 17h1M19.2 17h1"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, stroke = 1.7, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: '0 0 auto' }}
      // Markup is the constant map above, never user input.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function Logo({ size = 38 }: { size?: number }) {
  return <img src={assetUrl('brand/logo-mark.png')} height={size} style={{ height: size, width: 'auto', alignSelf: 'flex-start', flex: 'none' }} alt="" aria-hidden="true" />;
}
